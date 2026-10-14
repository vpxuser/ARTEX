package tool

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

// ToolArtifact is a bounded, host-only record of what a tool actually accessed
// or changed. It must never be added to the model's tool-result content.
type ToolArtifact struct {
	Version           int     `json:"version"`
	Kind              string  `json:"kind"`
	Path              string  `json:"path"`
	WorkingDir        string  `json:"working_dir"`
	Operation         string  `json:"operation,omitempty"`
	BeforeExists      *bool   `json:"before_exists,omitempty"`
	Before            *string `json:"before,omitempty"`
	After             *string `json:"after,omitempty"`
	SnapshotAvailable *bool   `json:"snapshot_available,omitempty"`
	UnavailableReason string  `json:"unavailable_reason,omitempty"`
	Truncated         bool    `json:"truncated,omitempty"`
	// Read ranges are inclusive file line numbers selected by the execution.
	// Truncated is also true when output caps hide part of this selected range.
	LineStart int                 `json:"line_start,omitempty"`
	LineEnd   int                 `json:"line_end,omitempty"`
	Entries   []ToolArtifactEntry `json:"entries,omitempty"`
	Query     string              `json:"query,omitempty"`
}

type ToolArtifactEntry struct {
	Path  string `json:"path"`
	Line  int    `json:"line,omitempty"`
	Text  string `json:"text,omitempty"`
	Count *int   `json:"count,omitempty"`
}

const maxArtifactSnapshot = 128 << 10
const maxArtifactEntries = 200
const maxArtifactEntryText = 2000

// artifactPath never turns a successful tool into a failure. Resolve symlinks
// after the operation so a recorded path identifies the file actually used.
func artifactPath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved
	}
	return filepath.Clean(abs)
}

func newArtifact(tc *ToolContext, kind, path string) *ToolArtifact {
	wd := "."
	if tc != nil && tc.WorkingDir != "" {
		wd = tc.WorkingDir
	}
	return &ToolArtifact{Version: 1, Kind: kind, Path: artifactPath(path), WorkingDir: artifactPath(wd)}
}

func artifactResult(result Result, artifact *ToolArtifact) Result {
	result.Artifact = artifact
	return result
}

// readBeforeSnapshot is best-effort and bounded. Write must still succeed when
// it has write permission but cannot read the previous file for the UI.
func readBeforeSnapshot(path string, info os.FileInfo, statErr error) ([]byte, *bool, string) {
	exists := true
	if os.IsNotExist(statErr) {
		exists = false
		return nil, &exists, ""
	}
	if statErr != nil {
		return nil, nil, "before_unreadable"
	}
	if !info.Mode().IsRegular() {
		return nil, &exists, "before_unreadable"
	}
	if info.Size() > maxArtifactSnapshot {
		return nil, &exists, "snapshot_too_large"
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, &exists, "before_unreadable"
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxArtifactSnapshot+1))
	if err != nil {
		return nil, &exists, "before_unreadable"
	}
	return data, &exists, ""
}

func changeArtifact(tc *ToolContext, path, operation string, before []byte, after string, existed *bool, reason string) *ToolArtifact {
	a := newArtifact(tc, "change", path)
	a.Operation, a.BeforeExists = operation, existed
	available := false
	a.SnapshotAvailable = &available
	if reason == "" && (len(before) > maxArtifactSnapshot || len(after) > maxArtifactSnapshot) {
		reason = "snapshot_too_large"
	}
	if reason == "" && (!utf8.Valid(before) || !utf8.ValidString(after) || bytes.IndexByte(before, 0) >= 0 || bytes.IndexByte([]byte(after), 0) >= 0) {
		reason = "binary_or_invalid_utf8"
	}
	if a.Path == "" && reason == "" {
		reason = "path_unavailable"
	}
	if reason != "" {
		a.UnavailableReason = reason
		a.Truncated = reason == "snapshot_too_large"
		return a
	}
	old := string(before)
	a.Before, a.After = &old, &after
	available = true
	return a
}

func (a *ToolArtifact) addEntry(entry ToolArtifactEntry) {
	if len(a.Entries) >= maxArtifactEntries {
		a.Truncated = true
		return
	}
	entry.Path = artifactPath(entry.Path)
	if len(entry.Text) > maxArtifactEntryText {
		end := maxArtifactEntryText
		for end > 0 && !utf8.RuneStart(entry.Text[end]) {
			end--
		}
		entry.Text = entry.Text[:end]
		a.Truncated = true
	}
	a.Entries = append(a.Entries, entry)
}
