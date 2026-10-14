package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Autumn-27/artex/db"
)

type workspacePreviewFile struct {
	Path     string  `json:"path"`
	Size     int64   `json:"size"`
	Binary   bool    `json:"binary"`
	TooLarge bool    `json:"too_large,omitempty"`
	Content  *string `json:"content,omitempty"`
}

type previewError struct {
	status  int
	message string
}

func (e *previewError) Error() string { return e.message }

func previewFailure(status int, message string) error { return &previewError{status, message} }

type previewArtifact struct {
	Version    int    `json:"version"`
	Kind       string `json:"kind"`
	Path       string `json:"path"`
	WorkingDir string `json:"working_dir"`
	Entries    []struct {
		Path string `json:"path"`
	} `json:"entries"`
}

// GET /api/workspace/preview?conversation=<id>&activity_seq=<seq>[&path=<entry>]
// or ?task=<id>&activity_seq=<seq>[&path=<entry>]. The requested task authorizes
// inherited records; their source task and intent are derived from the record.
// Legacy links may omit activity_seq and use a relative path plus an explicit
// conversation, or task and optional local intent. Source IDs are never accepted.
func (s *Server) wsPreview(w http.ResponseWriter, r *http.Request) {
	scope, record, err := s.workspacePreviewScope(r)
	if err != nil {
		writePreviewError(w, err)
		return
	}
	base, err := filepath.Abs(s.m.dir)
	if err != nil {
		writePreviewError(w, err)
		return
	}
	// Capture records use the real CWD. The configured workspace itself may be
	// a symlink (for example a mounted data directory); normalize that root while
	// keeping per-session scope components subject to openPreviewScope checks.
	base, err = filepath.EvalSymlinks(base)
	if err != nil {
		writePreviewError(w, err)
		return
	}
	var rel string
	if record != nil {
		rel, err = artifactPreviewPath(filepath.Join(base, scope), record, r.URL.Query().Get("path"))
	} else {
		rel, err = localPreviewPath(r.URL.Query().Get("path"))
	}
	if err != nil {
		writePreviewError(w, err)
		return
	}
	file, err := readWorkspacePreview(base, scope, rel)
	if err != nil {
		writePreviewError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, file)
}

func writePreviewError(w http.ResponseWriter, err error) {
	var failure *previewError
	if errors.As(err, &failure) {
		writeErr(w, failure.status, failure.message)
	} else if errors.Is(err, os.ErrNotExist) {
		writeErr(w, http.StatusNotFound, "文件或原始工作目录已不存在")
	} else if errors.Is(err, os.ErrPermission) {
		writeErr(w, http.StatusForbidden, "无法读取此文件")
	} else if strings.Contains(err.Error(), "path escapes") {
		writeErr(w, http.StatusForbidden, "文件符号链接超出原 Agent 工作目录")
	} else {
		writeErr(w, http.StatusInternalServerError, "文件预览失败")
	}
}

func positivePreviewID(raw string) (int64, error) {
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, previewFailure(http.StatusBadRequest, "会话、任务、意图或活动编号无效")
	}
	return id, nil
}

func (s *Server) workspacePreviewScope(r *http.Request) (string, *db.Activity, error) {
	q := r.URL.Query()
	conversation, taskID := q.Get("conversation"), q.Get("task")
	if (conversation == "") == (taskID == "") || q.Has("source_task_id") {
		return "", nil, previewFailure(http.StatusBadRequest, "请指定一个当前会话或任务；继承文件必须通过原活动定位")
	}
	var seq int64
	if q.Has("activity_seq") {
		var err error
		seq, err = positivePreviewID(q.Get("activity_seq"))
		if err != nil {
			return "", nil, err
		}
	}
	if conversation != "" {
		if q.Has("intent") {
			return "", nil, previewFailure(http.StatusBadRequest, "普通会话不能指定任务意图")
		}
		id, err := positivePreviewID(conversation)
		if err != nil {
			return "", nil, err
		}
		c, err := s.m.pg.GetConversation(id)
		if err != nil {
			return "", nil, err
		}
		if c == nil {
			return "", nil, previewFailure(http.StatusNotFound, "会话不存在")
		}
		var record *db.Activity
		if seq > 0 {
			record, err = s.m.pg.ConvActivityRecord(id, seq)
			if err != nil {
				return "", nil, err
			}
			if record == nil {
				return "", nil, previewFailure(http.StatusNotFound, "活动不存在或不属于当前会话")
			}
		}
		return filepath.Join("sessions", "conv-"+strconv.FormatInt(id, 10)), record, nil
	}
	id, err := positivePreviewID(taskID)
	if err != nil {
		return "", nil, err
	}
	t, ok := s.m.Task(strconv.FormatInt(id, 10))
	if !ok {
		return "", nil, previewFailure(http.StatusNotFound, "任务不存在")
	}
	var record *db.Activity
	var intentID int64
	if seq > 0 {
		if q.Has("intent") {
			return "", nil, previewFailure(http.StatusBadRequest, "活动定位时无需指定意图")
		}
		record, err = t.Store.ActivityRecordWithSources(seq)
		if err != nil {
			return "", nil, err
		}
		if record == nil {
			return "", nil, previewFailure(http.StatusNotFound, "活动不存在或不在当前任务可访问范围")
		}
		if record.Inherited {
			id = record.SourceTaskID
		}
		if record.NodeID != nil {
			intentID = *record.NodeID
		}
	} else if q.Has("intent") {
		intentID, err = positivePreviewID(q.Get("intent"))
		if err != nil {
			return "", nil, err
		}
		node, err := t.Store.GetNode(intentID)
		if err != nil {
			return "", nil, err
		}
		if node == nil || node.Kind != db.KindIntent {
			return "", nil, previewFailure(http.StatusNotFound, "意图不属于当前任务；继承文件请通过活动定位")
		}
	}
	scope := filepath.Join("tasks", strconv.FormatInt(id, 10))
	if intentID > 0 {
		scope = filepath.Join(scope, "i"+strconv.FormatInt(intentID, 10))
	}
	return scope, record, nil
}

func localPreviewPath(raw string) (string, error) {
	if raw == "" || strings.ContainsRune(raw, 0) || !filepath.IsLocal(raw) || strings.Contains(raw, "\\") || (len(raw) > 1 && raw[1] == ':') {
		return "", previewFailure(http.StatusBadRequest, "请提供当前 Agent 工作目录内的相对文件路径")
	}
	for _, part := range strings.Split(filepath.ToSlash(raw), "/") {
		if part == ".." {
			return "", previewFailure(http.StatusBadRequest, "文件路径不能包含上级目录")
		}
	}
	return filepath.Clean(raw), nil
}

func recordedPreviewPath(scope, path string) (string, error) {
	if path == "" {
		return "", previewFailure(http.StatusBadRequest, "此记录没有可预览的文件路径")
	}
	if !filepath.IsAbs(path) {
		return localPreviewPath(path)
	}
	rel, err := filepath.Rel(scope, filepath.Clean(path))
	if err != nil || !filepath.IsLocal(rel) {
		return "", previewFailure(http.StatusForbidden, "记录中的文件不在原 Agent 工作目录内")
	}
	return rel, nil
}

func artifactPreviewPath(scope string, record *db.Activity, requested string) (string, error) {
	var metadata struct {
		Artifact *previewArtifact `json:"tool_artifact"`
	}
	if json.Unmarshal(record.Metadata, &metadata) != nil || metadata.Artifact == nil || metadata.Artifact.Version != 1 {
		return "", previewFailure(http.StatusConflict, "旧记录没有可靠文件定位信息，无法安全预览")
	}
	a := metadata.Artifact
	if !filepath.IsAbs(a.WorkingDir) || filepath.Clean(a.WorkingDir) != filepath.Clean(scope) {
		return "", previewFailure(http.StatusConflict, "原始工作目录缺失或已迁移，无法安全定位文件")
	}
	if a.Kind != "read" && a.Kind != "change" && a.Kind != "search" && a.Kind != "directory" {
		return "", previewFailure(http.StatusBadRequest, "此工具记录不支持文件预览")
	}
	if requested == "" {
		return recordedPreviewPath(scope, a.Path)
	}
	wanted, err := localPreviewPath(requested)
	if err != nil {
		// An absolute path supplied by the viewer is accepted only if it exactly
		// names a file already present in this authorized artifact below.
		if !filepath.IsAbs(requested) {
			return "", err
		}
		wanted, err = recordedPreviewPath(scope, requested)
		if err != nil {
			return "", err
		}
	}
	candidates := []string{a.Path}
	for _, entry := range a.Entries {
		candidates = append(candidates, entry.Path)
	}
	for _, candidate := range candidates {
		rel, err := recordedPreviewPath(scope, candidate)
		if err == nil && rel == wanted {
			return wanted, nil
		}
	}
	return "", previewFailure(http.StatusForbidden, "文件未出现在此活动的记录中")
}

// Open each scope component without accepting symlinks. Comparing the opened
// directory identity closes the lstat/open race; the final os.Root also confines
// file symlinks and concurrent renames to this original Agent directory.
func openPreviewScope(base, scope string) (*os.Root, error) {
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	for _, component := range strings.Split(filepath.ToSlash(scope), "/") {
		if component == "" || component == "." || component == ".." {
			root.Close()
			return nil, previewFailure(http.StatusForbidden, "工作目录不在允许范围内")
		}
		info, err := root.Lstat(component)
		if err != nil {
			root.Close()
			return nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, previewFailure(http.StatusForbidden, "工作目录不能通过符号链接跳转")
		}
		next, err := root.OpenRoot(component)
		root.Close()
		if err != nil {
			return nil, err
		}
		opened, err := next.Stat(".")
		if err != nil || !os.SameFile(info, opened) {
			next.Close()
			return nil, previewFailure(http.StatusForbidden, "工作目录在读取时发生变化")
		}
		root = next
	}
	return root, nil
}

func readWorkspacePreview(base, scope, rel string) (workspacePreviewFile, error) {
	result := workspacePreviewFile{Path: filepath.ToSlash(filepath.Join(scope, rel))}
	root, err := openPreviewScope(base, scope)
	if err != nil {
		return result, err
	}
	defer root.Close()
	before, err := root.Stat(rel)
	if err != nil {
		return result, err
	}
	if !before.Mode().IsRegular() {
		return result, previewFailure(http.StatusBadRequest, "只能预览普通文件")
	}
	file, err := root.Open(rel)
	if err != nil {
		return result, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return result, err
	}
	if !info.Mode().IsRegular() {
		return result, previewFailure(http.StatusBadRequest, "只能预览普通文件")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxWorkspaceRead+1))
	if err != nil {
		return result, fmt.Errorf("read preview: %w", err)
	}
	result.Size = info.Size()
	result.TooLarge = result.Size > maxWorkspaceRead || len(data) > maxWorkspaceRead
	if result.TooLarge {
		// A capped read may split the final UTF-8 rune; that is not binary data.
		for i := len(data) - 1; i >= 0 && i >= len(data)-utf8.UTFMax; i-- {
			if utf8.RuneStart(data[i]) {
				if !utf8.FullRune(data[i:]) {
					data = data[:i]
				}
				break
			}
		}
	}
	result.Binary = bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data)
	if !result.TooLarge && !result.Binary {
		content := string(data)
		result.Content = &content
	}
	return result, nil
}
