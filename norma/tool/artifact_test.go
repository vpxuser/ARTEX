package tool

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func requireChange(t *testing.T, result Result, path, before, after, operation string) *ToolArtifact {
	t.Helper()
	a := result.Artifact
	if result.IsError || a == nil || a.Version != 1 || a.Kind != "change" || a.Path != artifactPath(path) || a.Operation != operation {
		t.Fatalf("unexpected change: result=%q artifact=%+v", result.Flatten(), a)
	}
	if a.SnapshotAvailable == nil || !*a.SnapshotAvailable || a.Before == nil || a.After == nil || *a.Before != before || *a.After != after {
		t.Fatalf("wrong before/after snapshots: %+v", a)
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != after {
		t.Fatalf("snapshot differs from file: %q, %v", actual, err)
	}
	return a
}

func TestToolArtifactsRecordSuccessfulFileChanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")
	a := requireChange(t, run(t, NewWrite(), dir, map[string]any{"file_path": "file.txt", "content": ""}), path, "", "", "create")
	encoded, _ := json.Marshal(a)
	if a.BeforeExists == nil || *a.BeforeExists || !strings.Contains(string(encoded), `"before":""`) || !strings.Contains(string(encoded), `"before_exists":false`) {
		t.Fatalf("empty snapshots/false existence lost in JSON: %s", encoded)
	}
	requireChange(t, run(t, NewWrite(), dir, map[string]any{"file_path": "file.txt", "content": "alpha\nbeta\nalpha\n"}), path, "", "alpha\nbeta\nalpha\n", "overwrite")
	requireChange(t, run(t, NewEdit(), dir, map[string]any{"file_path": "file.txt", "old_string": "alpha", "new_string": "gamma\ndelta", "replace_all": true}), path,
		"alpha\nbeta\nalpha\n", "gamma\ndelta\nbeta\ngamma\ndelta\n", "edit")
	requireChange(t, run(t, NewMultiEdit(), dir, map[string]any{"file_path": "file.txt", "edits": []any{
		map[string]any{"old_string": "beta", "new_string": "epsilon"},
		map[string]any{"old_string": "epsilon", "new_string": "zeta"},
	}}), path, "gamma\ndelta\nbeta\ngamma\ndelta\n", "gamma\ndelta\nzeta\ngamma\ndelta\n", "edit")

	failed := run(t, NewEdit(), dir, map[string]any{"file_path": "file.txt", "old_string": "missing", "new_string": "bad"})
	if !failed.IsError || failed.Artifact != nil {
		t.Fatalf("failed edit claims a change: %+v", failed)
	}
	failed = run(t, NewWrite(), dir, map[string]any{"file_path": ".", "content": "bad"})
	if !failed.IsError || failed.Artifact != nil {
		t.Fatalf("failed write claims a change: %+v", failed)
	}
	failed = run(t, NewMultiEdit(), dir, map[string]any{"file_path": "file.txt", "edits": []any{
		map[string]any{"old_string": "zeta", "new_string": "changed"},
		map[string]any{"old_string": "missing", "new_string": "bad"},
	}})
	if !failed.IsError || failed.Artifact != nil {
		t.Fatalf("failed batch claims a change: %+v", failed)
	}
}

func TestToolArtifactSnapshotLimitsNeverFailWrites(t *testing.T) {
	for _, fixture := range []struct{ name, before, after, reason string }{
		{"large_before", strings.Repeat("a", maxArtifactSnapshot+1), "small", "snapshot_too_large"},
		{"large_after", "small", strings.Repeat("a", maxArtifactSnapshot+1), "snapshot_too_large"},
		{"binary_before", "a\x00b", "small", "binary_or_invalid_utf8"},
		{"invalid_utf8", "a\xffb", "small", "binary_or_invalid_utf8"},
		{"binary_after", "small", "a\x00b", "binary_or_invalid_utf8"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "target")
			if err := os.WriteFile(path, []byte(fixture.before), 0600); err != nil {
				t.Fatal(err)
			}
			r := run(t, NewWrite(), dir, map[string]any{"file_path": "target", "content": fixture.after})
			a := r.Artifact
			if r.IsError || a == nil || a.SnapshotAvailable == nil || *a.SnapshotAvailable || a.Before != nil || a.After != nil || a.UnavailableReason != fixture.reason {
				t.Fatalf("bad unavailable snapshot: result=%q artifact=%+v", r.Flatten(), a)
			}
			if a.Truncated != (fixture.reason == "snapshot_too_large") {
				t.Fatalf("wrong truncated flag: %+v", a)
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != fixture.after {
				t.Fatalf("write changed behavior: %q %v", got, err)
			}
		})
	}
}

func TestToolArtifactReadRangeAndResolvedPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "actual.txt")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\n"), 0600); err != nil {
		t.Fatal(err)
	}
	inputPath := "actual.txt"
	if err := os.Symlink(path, filepath.Join(dir, "alias.txt")); err == nil {
		inputPath = "alias.txt"
	}
	r := run(t, NewRead(), dir, map[string]any{"file_path": inputPath, "offset": 2, "limit": 1})
	a := r.Artifact
	if r.IsError || a == nil || a.Kind != "read" || a.Path != artifactPath(path) || a.WorkingDir != artifactPath(dir) || a.LineStart != 2 || a.LineEnd != 2 || !a.Truncated || a.Before != nil || a.After != nil {
		t.Fatalf("read artifact=%+v result=%q", a, r.Flatten())
	}
	if !strings.Contains(r.Flatten(), "2\ttwo") {
		t.Fatalf("read result changed: %q", r.Flatten())
	}
}

func TestToolArtifactSearchAndDirectoryBoundedEntries(t *testing.T) {
	t.Setenv("NORMA_DISABLE_RIPGREP", "1")
	dir := t.TempDir()
	for i := 0; i < maxArtifactEntries+5; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%03d.txt", i)), []byte("before\nmatch\nafter\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, spec := range []struct {
		tool  CoreTool
		input map[string]any
	}{
		{NewGlob(), map[string]any{"pattern": "*.txt"}},
		{NewLS(), map[string]any{}},
		{NewGrep(), map[string]any{"pattern": "match", "head_limit": 0}},
	} {
		r := run(t, spec.tool, dir, spec.input)
		a := r.Artifact
		if r.IsError || a == nil || len(a.Entries) != maxArtifactEntries || !a.Truncated || a.Path != artifactPath(dir) {
			t.Fatalf("%s entries not bounded: %+v", spec.tool.Name(), a)
		}
		if !filepath.IsAbs(a.Entries[0].Path) {
			t.Fatalf("non-absolute result path: %+v", a.Entries[0])
		}
	}
	r := run(t, NewGrep(), dir, map[string]any{"pattern": "match", "path": "f000.txt", "output_mode": "content", "-C": 1, "offset": 1, "head_limit": 1})
	a := r.Artifact
	if a == nil || len(a.Entries) != 1 || a.Entries[0].Line != 2 || a.Entries[0].Text != "match" || !a.Truncated || a.Query != "match" {
		t.Fatalf("wrong structured search page: %+v", a)
	}
	// Structured locations come from the scan, even when the model-facing text
	// omits line numbers or the filename itself contains output delimiters.
	strange := "file:with-dash.txt"
	if err := os.WriteFile(filepath.Join(dir, strange), []byte("before\nmatch: literal-value\nafter\n"), 0600); err == nil {
		r = run(t, NewGrep(), dir, map[string]any{"pattern": "match", "path": strange, "output_mode": "content", "-n": false})
		a = r.Artifact
		if a == nil || len(a.Entries) != 1 || a.Entries[0].Line != 2 || a.Entries[0].Text != "match: literal-value" || a.Entries[0].Path != artifactPath(filepath.Join(dir, strange)) {
			t.Fatalf("ambiguous filename corrupted structured result: %+v", a)
		}
	}
}
