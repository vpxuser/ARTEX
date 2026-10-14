package tool

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func installedRipgrep(t *testing.T) string {
	t.Helper()
	rg, err := exec.LookPath("rg")
	if err != nil {
		t.Skip("ripgrep not installed")
	}
	return rg
}

func TestRipgrepArtifactsKeepAmbiguousFilenamesAndSingleFileScope(t *testing.T) {
	rg := installedRipgrep(t)
	dir := t.TempDir()
	names := []string{"colon:name.txt", "space name.txt", "line\nbreak.txt"}
	paths := map[string]bool{}
	for _, name := range names {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("zero\nneedle first\nmiddle\nneedle second\nlast\n"), 0600); err != nil {
			if runtime.GOOS == "windows" {
				t.Skip("filename unsupported on Windows")
			}
			t.Fatal(err)
		}
		paths[artifactPath(path)] = true
	}
	unlimited := 0
	for _, mode := range []string{"files_with_matches", "content", "count"} {
		t.Run(mode, func(t *testing.T) {
			req := ripgrepReq{pattern: "needle", mode: mode, root: dir, showLines: true, headLimit: &unlimited}
			result, ok := runWithRipgrep(rg, req, &ToolContext{WorkingDir: dir})
			a := result.Artifact
			want := len(names)
			if mode == "content" {
				want *= 2
			}
			if !ok || result.IsError || a == nil || len(a.Entries) != want || a.UnavailableReason != "" || a.Truncated {
				t.Fatalf("directory results: ok=%v output=%q artifact=%+v", ok, result.Flatten(), a)
			}
			for _, e := range a.Entries {
				if !paths[e.Path] {
					t.Fatalf("filename was split or misparsed: %+v", e)
				}
				if mode == "content" && (e.Line != 2 && e.Line != 4 || !strings.HasPrefix(e.Text, "needle")) {
					t.Fatalf("bad content location: %+v", e)
				}
				if mode == "count" && (e.Count == nil || *e.Count != 2) {
					t.Fatalf("bad match count: %+v", e)
				}
			}
			one := 1
			paged := req
			paged.headLimit, paged.offset = &one, 1
			pageResult, pageOK := runWithRipgrep(rg, paged, &ToolContext{WorkingDir: dir})
			if !pageOK || pageResult.Artifact == nil || len(pageResult.Artifact.Entries) != 1 || !pageResult.Artifact.Truncated || !paths[pageResult.Artifact.Entries[0].Path] {
				t.Fatalf("paging split a filename: %+v", pageResult.Artifact)
			}
			for _, name := range names {
				req.root = filepath.Join(dir, name)
				result, ok = runWithRipgrep(rg, req, &ToolContext{WorkingDir: dir})
				a = result.Artifact
				want = 1
				if mode == "content" {
					want = 2
				}
				if !ok || a == nil || len(a.Entries) != want || a.UnavailableReason != "" {
					t.Fatalf("single-file result: %+v %q", a, result.Flatten())
				}
				for _, entry := range a.Entries {
					if entry.Path != artifactPath(req.root) {
						t.Fatalf("single-file scope path lost: %+v", entry)
					}
				}
				if mode == "count" && result.Flatten() != "2\n" {
					t.Fatalf("single-file count output changed: %q", result.Flatten())
				}
			}
		})
	}
}

func TestRipgrepBinaryContentHasExplicitFallback(t *testing.T) {
	rg := installedRipgrep(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "binary")
	if err := os.WriteFile(path, []byte("needle\x00hidden\n"), 0600); err != nil {
		t.Fatal(err)
	}
	result, ok := runWithRipgrep(rg, ripgrepReq{pattern: "needle", mode: "content", root: path, showLines: true}, &ToolContext{WorkingDir: dir})
	if !ok || result.Artifact == nil || result.Artifact.UnavailableReason != "binary_or_invalid_utf8" || strings.ContainsRune(result.Flatten(), 0) || !strings.Contains(result.Flatten(), "binary file matches") {
		t.Fatalf("binary payload was presented as text: %q %+v", result.Flatten(), result.Artifact)
	}
}

// Compare rendering against the previous rg flags. Both baseline and new calls
// are test executions; production still executes rg only once per tool call.
func TestRipgrepArtifactRenderingPreservesTextPagingAndMultiline(t *testing.T) {
	rg := installedRipgrep(t)
	dir := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("zero\nneedle first\nmiddle\nskip1\nskip2\nskip3\nneedle second\nlast\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	limit := 3
	for _, req := range []ripgrepReq{
		{pattern: "needle", mode: "content", root: filepath.Join(dir, "a.txt"), showLines: true, before: 1, after: 1},
		{pattern: "needle", mode: "content", root: filepath.Join(dir, "a.txt"), showLines: false, before: 1, after: 1, offset: 2, headLimit: &limit},
		{pattern: "needle first\\nmiddle", mode: "content", root: filepath.Join(dir, "a.txt"), showLines: true, multiline: true, before: 1, after: 1},
		{pattern: "needle first\\nmiddle\\n", mode: "content", root: filepath.Join(dir, "a.txt"), showLines: false, multiline: true},
		{pattern: "needle", mode: "content", root: dir, showLines: true, before: 1, after: 1},
		{pattern: "needle", mode: "count", root: dir},
		{pattern: "needle", mode: "files_with_matches", root: dir},
	} {
		args := []string{"--color", "never", "--threads", "1"}
		if req.multiline {
			args = append(args, "-U", "--multiline-dotall")
		}
		switch req.mode {
		case "files_with_matches":
			args = append(args, "-l")
		case "count":
			args = append(args, "-c")
		default:
			args = append(args, "--no-heading")
			if req.showLines {
				args = append(args, "-n")
			}
			if req.before > 0 {
				args = append(args, "-B", strconv.Itoa(req.before))
			}
			if req.after > 0 {
				args = append(args, "-A", strconv.Itoa(req.after))
			}
		}
		cwd, target := req.root, "."
		if info, _ := os.Stat(req.root); !info.IsDir() {
			cwd, target = filepath.Dir(req.root), filepath.Base(req.root)
		}
		cmd := exec.Command(rg, append(args, "-e", req.pattern, "--", target)...)
		cmd.Dir = cwd
		baseline, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		rows := strings.Split(strings.TrimRight(string(baseline), "\n"), "\n")
		head := 250
		if req.headLimit != nil {
			head = *req.headLimit
		}
		rows, more := applyHeadOffset(rows, head, req.offset)
		want := strings.Join(rows, "\n")
		if len(rows) > 0 {
			want += "\n"
		}
		if more > 0 {
			want += fmt.Sprintf("... [%d more result(s) — page with offset=%d, or head_limit=0 for all] ...\n", more, req.offset+len(rows))
		}
		result, ok := runWithRipgrep(rg, req, &ToolContext{WorkingDir: dir})
		if !ok || result.Artifact == nil || result.Artifact.UnavailableReason != "" {
			t.Fatalf("decode failed: %q %+v", result.Flatten(), result.Artifact)
		}
		// rg directory walking can choose a different file order across executions.
		// Single-file comparisons are exact; directory comparisons preserve each file's block.
		if target != "." && result.Flatten() != want {
			t.Fatalf("req=%+v\nwant=%q\ngot =%q", req, want, result.Flatten())
		}
		if target == "." {
			for _, line := range strings.Split(strings.TrimSuffix(want, "\n"), "\n") {
				if !strings.Contains(result.Flatten(), line+"\n") {
					t.Fatalf("missing baseline line %q from %q", line, result.Flatten())
				}
			}
		}
		if result.Artifact.Truncated != (req.offset > 0 || more > 0) {
			t.Fatalf("wrong page truncation: %+v", result.Artifact)
		}
	}
}

func TestRipgrepArtifactBoundsAndSingleInvocation(t *testing.T) {
	rg := installedRipgrep(t)
	dir := t.TempDir()
	for i := 0; i < maxArtifactEntries+5; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%03d.txt", i)), []byte("needle\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	unlimited := 0
	for _, mode := range []string{"files_with_matches", "content", "count"} {
		result, ok := runWithRipgrep(rg, ripgrepReq{pattern: "needle", mode: mode, root: dir, headLimit: &unlimited}, &ToolContext{WorkingDir: dir, MaxOutputChars: 200})
		if !ok || result.Artifact == nil || len(result.Artifact.Entries) != maxArtifactEntries || !result.Artifact.Truncated || result.Artifact.UnavailableReason != "" {
			t.Fatalf("unbounded %s artifact: %+v", mode, result.Artifact)
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	counter := filepath.Join(t.TempDir(), "invocations")
	shim := filepath.Join(t.TempDir(), "rg-shim")
	t.Setenv("ARTEX_TEST_RG_COUNTER", counter)
	t.Setenv("ARTEX_TEST_RG_BINARY", rg)
	if err := os.WriteFile(shim, []byte("#!/bin/sh\nprintf 'called\\n' >> \"$ARTEX_TEST_RG_COUNTER\"\nexec \"$ARTEX_TEST_RG_BINARY\" \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	limit := 1
	result, ok := runWithRipgrep(shim, ripgrepReq{pattern: "needle", mode: "content", root: dir, headLimit: &limit, offset: 1}, &ToolContext{WorkingDir: dir})
	calls, err := os.ReadFile(counter)
	if err != nil || string(calls) != "called\n" || !ok || result.Artifact == nil || len(result.Artifact.Entries) != 1 || !result.Artifact.Truncated {
		t.Fatalf("search repeated or page incorrect: calls=%q err=%v result=%+v", calls, err, result.Artifact)
	}
}
