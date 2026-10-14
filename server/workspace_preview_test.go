package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Autumn-27/artex/db"
)

func TestActivityMetadataSummaryKeepsAuditWithoutSnapshots(t *testing.T) {
	raw := json.RawMessage(`{"llm_transition":{"mode":"automatic","next":{"name":"backup"}},"tool_artifact":{"version":1,"kind":"change","path":"/work/file.txt","working_dir":"/work","before":"old","after":"new","entries":[{"path":"a","text":"large"},{"path":"b"}],"snapshot_available":true}}`)
	before := string(raw)
	dto := activityDTO(db.Activity{Metadata: raw})
	var got, original map[string]json.RawMessage
	if err := json.Unmarshal(dto.Metadata, &got); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(raw, &original)
	var artifact map[string]any
	_ = json.Unmarshal(got["tool_artifact"], &artifact)
	for _, key := range []string{"before", "after", "entries"} {
		if _, exists := artifact[key]; exists {
			t.Fatalf("list metadata leaked %s", key)
		}
	}
	if artifact["entry_count"] != float64(2) || artifact["path"] != "/work/file.txt" || artifact["snapshot_available"] != true {
		t.Fatalf("artifact identity lost: %s", dto.Metadata)
	}
	if !bytes.Equal(got["llm_transition"], original["llm_transition"]) || string(raw) != before {
		t.Fatal("summary modified the audit event or original metadata")
	}
	detail := activityDetailPayload(&db.Activity{Detail: "legacy detail", Metadata: raw})
	if detail.Detail != "legacy detail" || !bytes.Equal(detail.Metadata, raw) {
		t.Fatal("lazy detail did not preserve its full metadata")
	}
	if activityDetailPayload(nil).Detail != "" || string(activityDetailPayload(nil).Metadata) != "{}" {
		t.Fatal("missing records must keep the legacy empty detail without metadata")
	}
}

func previewTestArtifact(t *testing.T, scope, path string, entries ...string) *db.Activity {
	t.Helper()
	items := make([]map[string]string, 0, len(entries))
	for _, entry := range entries {
		items = append(items, map[string]string{"path": entry})
	}
	metadata, err := json.Marshal(map[string]any{"tool_artifact": map[string]any{
		"version": 1, "kind": "read", "working_dir": scope, "path": path, "entries": items,
		"after": "snapshot", "snapshot_available": true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	return &db.Activity{Kind: "tool_result", Metadata: metadata}
}

func TestArtifactPreviewPathUsesOriginalScopeAndRecordedFiles(t *testing.T) {
	scope := filepath.Join(t.TempDir(), "tasks", "7", "i9")
	file := filepath.Join(scope, "reports", "result.txt")
	a := previewTestArtifact(t, scope, file, "reports/another.txt")
	for _, request := range []string{"", "reports/result.txt", file} {
		rel, err := artifactPreviewPath(scope, a, request)
		if err != nil || rel != filepath.Join("reports", "result.txt") {
			t.Fatalf("request %q: rel=%q err=%v", request, rel, err)
		}
	}
	if rel, err := artifactPreviewPath(scope, a, "reports/another.txt"); err != nil || rel != filepath.Join("reports", "another.txt") {
		t.Fatalf("recorded search entry unavailable: %q %v", rel, err)
	}
	for _, request := range []string{"unrecorded.txt", "../other.txt", "/etc/passwd"} {
		if _, err := artifactPreviewPath(scope, a, request); err == nil {
			t.Fatalf("accepted unauthorized file %q", request)
		}
	}
	if _, err := artifactPreviewPath(filepath.Dir(scope), a, ""); err == nil {
		t.Fatal("record from a different working directory was silently remapped")
	}
	if _, err := artifactPreviewPath(scope, &db.Activity{Metadata: json.RawMessage(`{}`)}, "reports/result.txt"); err == nil {
		t.Fatal("legacy activity must not guess a path")
	}
	for _, path := range []string{"", "../secret", "reports/../../secret", "/etc/passwd", `C:\secret`, `..\secret`} {
		if _, err := localPreviewPath(path); err == nil {
			t.Fatalf("legacy path accepted %q", path)
		}
	}
}

func TestWorkspacePreviewReadLimitAndSymlinkBoundary(t *testing.T) {
	base := t.TempDir()
	scope := filepath.Join("sessions", "conv-7")
	dir := filepath.Join(base, scope)
	if err := os.MkdirAll(filepath.Join(dir, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(path string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, path), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("nested/text.txt", []byte("hello\n世界\n"))
	write("empty.txt", nil)
	write("binary.dat", []byte{'a', 0, 'b'})
	write("invalid.txt", []byte{0xff, 0xfe})
	write("large.txt", bytes.Repeat([]byte("x"), maxWorkspaceRead+100))
	for _, test := range []struct {
		path, content string
		binary, large bool
	}{
		{"nested/text.txt", "hello\n世界\n", false, false},
		{"empty.txt", "", false, false},
		{"binary.dat", "", true, false},
		{"invalid.txt", "", true, false},
		{"large.txt", "", false, true},
	} {
		got, err := readWorkspacePreview(base, scope, test.path)
		if err != nil {
			t.Fatal(err)
		}
		if got.Binary != test.binary || got.TooLarge != test.large || got.Path != filepath.ToSlash(filepath.Join(scope, test.path)) {
			t.Fatalf("flags/path for %q: %+v", test.path, got)
		}
		if test.binary || test.large {
			if got.Content != nil {
				t.Fatalf("non-previewable content returned for %q", test.path)
			}
		} else if got.Content == nil || *got.Content != test.content {
			t.Fatalf("text changed for %q: %+v", test.path, got)
		}
	}
	if _, err := readWorkspacePreview(base, scope, "nested"); err == nil {
		t.Fatal("directory read succeeded")
	}
	if err := os.Symlink(filepath.Join("nested", "text.txt"), filepath.Join(dir, "inside.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := readWorkspacePreview(base, scope, "inside.txt"); err != nil {
		t.Fatalf("safe in-scope relative symlink rejected: %v", err)
	}
	outside := filepath.Join(base, "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := readWorkspacePreview(base, scope, "escape.txt"); err == nil {
		t.Fatal("file symlink escaped the Agent scope")
	}
	if err := os.Symlink(dir, filepath.Join(base, "sessions", "conv-8")); err != nil {
		t.Fatal(err)
	}
	if _, err := readWorkspacePreview(base, filepath.Join("sessions", "conv-8"), "empty.txt"); err == nil {
		t.Fatal("scope root symlink borrowed another conversation directory")
	}
}

func TestWorkspacePreviewRejectsAmbiguousScope(t *testing.T) {
	s := &Server{m: &Manager{}}
	for _, query := range []string{"", "task=1&conversation=2", "task=1&source_task_id=2", "conversation=1&intent=2", "task=1&activity_seq=bad"} {
		rec := httptest.NewRecorder()
		s.wsPreview(rec, httptest.NewRequest(http.MethodGet, "/api/workspace/preview?"+query, nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("query %q status=%d body=%s", query, rec.Code, rec.Body.String())
		}
	}
}

func TestWorkspacePreviewActivityScopeAndLazyMetadata(t *testing.T) {
	m, err := NewManager(t.TempDir(), "")
	if err != nil {
		t.Skipf("postgres unavailable (%v)", err)
	}
	defer m.Close()
	s := &Server{m: m}
	source, err := m.CreateTaskWithOptions("preview source", "source", db.TaskCreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	current, err := m.CreateTaskWithOptions("preview current", "current", db.TaskCreateOptions{SourceTaskIDs: []int64{mustTaskID(t, source.ID)}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = m.DeleteTask(current.ID, DeleteTaskOptions{})
		_, _ = m.DeleteTask(source.ID, DeleteTaskOptions{})
	})
	intent, err := source.Store.AddIntent(map[string]any{"summary": "file producer"}, 1, nil, "planner")
	if err != nil {
		t.Fatal(err)
	}
	if err := source.Store.SetIntentState(intent, "done"); err != nil {
		t.Fatal(err)
	}
	cwd := filepath.Join(m.dir, "tasks", source.ID, "i"+strconv.FormatInt(intent, 10))
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(cwd, "result.txt")
	if err := os.WriteFile(file, []byte("original worker file"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := previewTestArtifact(t, cwd, file)
	a.NodeID, a.Worker, a.Detail = &intent, "worker", "full tool detail"
	seq, err := source.Store.AppendActivity(*a)
	if err != nil {
		t.Fatal(err)
	}
	request := func(query string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		s.wsPreview(rec, httptest.NewRequest(http.MethodGet, "/api/workspace/preview?"+query, nil))
		return rec
	}
	query := "task=" + current.ID + "&activity_seq=" + strconv.FormatInt(seq, 10)
	legacy := request("task=" + source.ID + "&intent=" + strconv.FormatInt(intent, 10) + "&path=result.txt")
	if legacy.Code != http.StatusOK || !strings.Contains(legacy.Body.String(), "original worker file") {
		t.Fatalf("explicit local intent path: %d %s", legacy.Code, legacy.Body.String())
	}
	if got := request("task=" + current.ID + "&intent=" + strconv.FormatInt(intent, 10) + "&path=result.txt"); got.Code != http.StatusNotFound {
		t.Fatalf("legacy path borrowed a source intent: %d %s", got.Code, got.Body.String())
	}
	got := request(query)
	if got.Code != http.StatusOK || !strings.Contains(got.Body.String(), "original worker file") {
		t.Fatalf("authorized source preview: %d %s", got.Code, got.Body.String())
	}
	detailReq := httptest.NewRequest(http.MethodGet, "/api/exploration/activity/ignored?task="+current.ID, nil)
	detailReq.SetPathValue("seq", strconv.FormatInt(seq, 10))
	detailRec := httptest.NewRecorder()
	s.activityDetail(detailRec, detailReq)
	if !strings.Contains(detailRec.Body.String(), `"after":"snapshot"`) || !strings.Contains(detailRec.Body.String(), "full tool detail") {
		t.Fatalf("inherited lazy metadata absent: %s", detailRec.Body.String())
	}
	if got := request(query + "&path=" + url.QueryEscape("unrecorded.txt")); got.Code != http.StatusForbidden {
		t.Fatalf("unrecorded source file: %d %s", got.Code, got.Body.String())
	}
	plannerArtifact := previewTestArtifact(t, filepath.Join(m.dir, "tasks", source.ID), filepath.Join(m.dir, "tasks", source.ID, "planner.txt"))
	plannerArtifact.Worker, plannerArtifact.Detail = "planner", "private planner detail"
	plannerSeq, err := source.Store.AppendActivity(*plannerArtifact)
	if err != nil {
		t.Fatal(err)
	}
	if got := request("task=" + current.ID + "&activity_seq=" + strconv.FormatInt(plannerSeq, 10)); got.Code != http.StatusNotFound {
		t.Fatalf("source planner preview leaked: %d %s", got.Code, got.Body.String())
	}
	plannerDetail, err := current.Store.ActivityRecordWithSources(plannerSeq)
	if err != nil || plannerDetail != nil {
		t.Fatalf("source planner metadata leaked: %+v %v", plannerDetail, err)
	}
	localThinking := db.Activity{Worker: "planner", Kind: "thinking", Detail: "local thought", Metadata: json.RawMessage(`{"audit":"local-only"}`)}
	thinkingSeq, err := current.Store.AppendActivity(localThinking)
	if err != nil {
		t.Fatal(err)
	}
	thinking, err := current.Store.ActivityRecordWithSources(thinkingSeq)
	if err != nil || thinking == nil || thinking.Detail != localThinking.Detail || !strings.Contains(string(thinking.Metadata), "local-only") {
		t.Fatalf("legacy local thinking lookup changed: %+v %v", thinking, err)
	}
	if got := request("task=" + current.ID + "&activity_seq=" + strconv.FormatInt(thinkingSeq, 10) + "&path=result.txt"); got.Code != http.StatusConflict {
		t.Fatalf("record without artifact guessed a file: %d %s", got.Code, got.Body.String())
	}
	if err := source.Store.SetIntentState(intent, "running"); err != nil {
		t.Fatal(err)
	}
	if got := request(query); got.Code != http.StatusNotFound {
		t.Fatalf("running source preview leaked: %d %s", got.Code, got.Body.String())
	}
	detailRec = httptest.NewRecorder()
	s.activityDetail(detailRec, detailReq)
	if strings.Contains(detailRec.Body.String(), "tool_artifact") || strings.Contains(detailRec.Body.String(), "full tool detail") {
		t.Fatalf("running source metadata leaked: %s", detailRec.Body.String())
	}

	conversation, err := m.pg.CreateConversation("mainagent", "preview conversation", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.pg.DeleteConversation(conversation.ID)
	other, err := m.pg.CreateConversation("mainagent", "other conversation", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.pg.DeleteConversation(other.ID)
	convDir := filepath.Join(m.dir, "sessions", "conv-"+strconv.FormatInt(conversation.ID, 10))
	if err := os.MkdirAll(convDir, 0o700); err != nil {
		t.Fatal(err)
	}
	convFile := filepath.Join(convDir, "chat.txt")
	if err := os.WriteFile(convFile, []byte("conversation file"), 0o600); err != nil {
		t.Fatal(err)
	}
	ca := previewTestArtifact(t, convDir, convFile)
	ca.Detail = "conversation detail"
	convSeq, err := m.pg.AppendConvActivity(conversation.ID, *ca)
	if err != nil {
		t.Fatal(err)
	}
	convQuery := "conversation=" + strconv.FormatInt(conversation.ID, 10) + "&activity_seq=" + strconv.FormatInt(convSeq, 10)
	if got := request(convQuery); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), "conversation file") {
		t.Fatalf("conversation preview: %d %s", got.Code, got.Body.String())
	}
	rootAlias := filepath.Join(t.TempDir(), "workspace-alias")
	if err := os.Symlink(m.dir, rootAlias); err != nil {
		t.Fatal(err)
	}
	originalDir := m.dir
	m.dir = rootAlias
	aliasPreview := request(convQuery)
	m.dir = originalDir
	if aliasPreview.Code != http.StatusOK || !strings.Contains(aliasPreview.Body.String(), "conversation file") {
		t.Fatalf("canonical artifact under workspace alias: %d %s", aliasPreview.Code, aliasPreview.Body.String())
	}
	if got := request("conversation=" + strconv.FormatInt(conversation.ID, 10) + "&path=chat.txt"); got.Code != http.StatusOK {
		t.Fatalf("local conversation legacy path: %d %s", got.Code, got.Body.String())
	}
	if got := request("conversation=" + strconv.FormatInt(other.ID, 10) + "&activity_seq=" + strconv.FormatInt(convSeq, 10)); got.Code != http.StatusNotFound {
		t.Fatalf("cross-conversation preview leaked: %d %s", got.Code, got.Body.String())
	}
	rows, _, err := m.pg.ConvActivityList(conversation.ID, 0, 10)
	if err != nil || len(rows) != 1 || !strings.Contains(string(rows[0].Metadata), "tool_artifact") {
		t.Fatalf("conversation metadata persistence: %+v %v", rows, err)
	}
	page, _, err := m.pg.ConvActivityPage(conversation.ID, 0, 10)
	if err != nil || len(page) != 1 || len(page[0].Metadata) == 0 {
		t.Fatalf("conversation history metadata persistence: %+v %v", page, err)
	}
	convDetailReq := httptest.NewRequest(http.MethodGet, "/", nil)
	convDetailReq.SetPathValue("id", strconv.FormatInt(conversation.ID, 10))
	convDetailReq.SetPathValue("seq", strconv.FormatInt(convSeq, 10))
	convDetailRec := httptest.NewRecorder()
	s.pgConversationMsgDetail(convDetailRec, convDetailReq)
	if convDetailRec.Code != http.StatusOK || !strings.Contains(convDetailRec.Body.String(), `"after":"snapshot"`) {
		t.Fatalf("conversation lazy metadata: %d %s", convDetailRec.Code, convDetailRec.Body.String())
	}
}
