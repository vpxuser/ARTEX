package tool

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// Ripgrep integration: the Grep tool prefers the ripgrep binary when available
// (faster, .gitignore-aware, full ripgrep syntax) and falls back to the pure-Go
// implementation otherwise. Resolution runs once:
//
//  1. an `rg` already on PATH is used as-is;
//  2. otherwise a best-effort `npm install -g @vscode/ripgrep` runs (npm is
//     assumed present) and the installed binary is located;
//  3. on any failure — no npm, install error, binary not found — the pure-Go
//     grep is used, so search always works.
//
// Env controls:
//   - NORMA_DISABLE_RIPGREP=1     force the pure-Go implementation (also used by tests)
//   - NORMA_RIPGREP_NO_INSTALL=1  use an existing rg but never auto-install

var (
	rgOnce     sync.Once
	rgResolved string
)

// RipgrepPath returns the resolved ripgrep binary path, or "" when the pure-Go
// grep should be used. The heavy resolution (detect + optional npm install) runs
// at most once per process.
func RipgrepPath() string {
	if os.Getenv("NORMA_DISABLE_RIPGREP") != "" {
		return ""
	}
	rgOnce.Do(func() { rgResolved = resolveRipgrep() })
	return rgResolved
}

// EnsureRipgrep warms ripgrep resolution so the cost (including a possible npm
// install) is paid at startup rather than on the first Grep call. Hosts may call
// it once at boot. Returns the resolved path ("" = Go fallback).
func EnsureRipgrep() string { return RipgrepPath() }

func resolveRipgrep() string {
	if p, err := exec.LookPath("rg"); err == nil {
		return p
	}
	if os.Getenv("NORMA_RIPGREP_NO_INSTALL") != "" {
		return ""
	}
	return installRipgrepViaNpm()
}

func installRipgrepViaNpm() string {
	if _, err := exec.LookPath("npm"); err != nil {
		return "" // no npm → Go fallback
	}
	cmd := exec.Command("npm", "install", "-g", "@vscode/ripgrep")
	if err := cmd.Run(); err != nil {
		return ""
	}
	if p, err := exec.LookPath("rg"); err == nil {
		return p
	}
	return npmGlobalRipgrep()
}

// npmGlobalRipgrep locates the rg binary vendored by @vscode/ripgrep in the npm
// global root (it exposes no `rg` command, so we resolve the path directly).
func npmGlobalRipgrep() string {
	out, err := exec.Command("npm", "root", "-g").Output()
	if err != nil {
		return ""
	}
	name := "rg"
	if runtime.GOOS == "windows" {
		name = "rg.exe"
	}
	p := filepath.Join(strings.TrimSpace(string(out)), "@vscode", "ripgrep", "bin", name)
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return p
	}
	return ""
}

// ripgrepReq carries the parsed Grep parameters for the ripgrep backend.
type ripgrepReq struct {
	pattern, glob, typ, mode         string
	ignoreCase, multiline, showLines bool
	before, after                    int
	root                             string
	headLimit                        *int
	offset                           int
}

// runWithRipgrep runs the query through the rg binary and formats the result.
// Returns ok=false when rg failed for a real reason (not "no matches"), so the
// caller falls back to the Go implementation.
func runWithRipgrep(rg string, r ripgrepReq, tc *ToolContext) (Result, bool) {
	artifact := newArtifact(tc, "search", r.root)
	artifact.Query = r.pattern
	args := []string{"--color", "never"}
	if r.ignoreCase {
		args = append(args, "-i")
	}
	if r.multiline {
		args = append(args, "-U", "--multiline-dotall")
	}
	switch r.mode {
	case "files_with_matches":
		args = append(args, "-l", "--null")
	case "count":
		args = append(args, "-c", "--null", "--with-filename")
	default: // content
		args = append(args, "--json")
		if r.before > 0 {
			args = append(args, "-B", strconv.Itoa(r.before))
		}
		if r.after > 0 {
			args = append(args, "-A", strconv.Itoa(r.after))
		}
	}
	if r.glob != "" {
		args = append(args, "--glob", r.glob)
	}
	if r.typ != "" {
		if _, known := rgFileTypes[strings.ToLower(r.typ)]; known {
			args = append(args, "--type", r.typ)
		} else {
			args = append(args, "--glob", "*."+r.typ) // unknown type → extension glob
		}
	}
	// Run inside root so printed paths are root-relative (matching the Go impl).
	dir, target := r.root, "."
	singleFile := false
	if st, err := os.Stat(r.root); err == nil && !st.IsDir() {
		dir, target = filepath.Dir(r.root), filepath.Base(r.root)
		singleFile = true
	}
	// `-e pattern --` keeps a pattern/path starting with '-' from being read as a flag.
	args = append(args, "-e", r.pattern, "--", target)

	cmd := exec.Command(rg, args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return artifactResult(Text("No matches found"), artifact), true // rg exit 1 = no matches
		}
		return Result{}, false // real failure → Go fallback
	}
	if len(out) == 0 {
		return artifactResult(Text("No matches found"), artifact), true
	}
	page := newRipgrepPage(r, artifact)
	var decodeErr error
	switch r.mode {
	case "files_with_matches":
		decodeErr = readRipgrepFiles(out, dir, page)
	case "count":
		decodeErr = readRipgrepCounts(out, dir, singleFile, page)
	default:
		decodeErr = readRipgrepContent(out, dir, singleFile, r, page)
	}
	if decodeErr != nil {
		// Unrecognised output from an older/wrapped rg is still useful evidence.
		// Do not guess locations or run the search a second time to fill metadata.
		artifact.Entries = nil
		artifact.UnavailableReason = "unstructured_search_output"
		raw := string(out)
		captured := Capture(tc, raw)
		artifact.Truncated = captured != raw
		return artifactResult(Text(captured), artifact), true
	}
	return page.result(tc), true
}

// A page is built while decoding the single rg execution. Entries stay bounded
// even when head_limit=0 asks for all model-facing result text.
type ripgrepPage struct {
	artifact                  *ToolArtifact
	offset, limit, seen, more int
	lines                     []string
}

func newRipgrepPage(r ripgrepReq, artifact *ToolArtifact) *ripgrepPage {
	limit := 250
	if r.headLimit != nil {
		limit = *r.headLimit
	}
	return &ripgrepPage{artifact: artifact, offset: max(0, r.offset), limit: limit}
}

func (p *ripgrepPage) add(text string, entry *ToolArtifactEntry) {
	position := p.seen
	p.seen++
	if position < p.offset {
		return
	}
	if p.limit > 0 && len(p.lines) >= p.limit {
		p.more++
		return
	}
	p.lines = append(p.lines, text)
	if entry != nil {
		if !utf8.ValidString(entry.Path) || !utf8.ValidString(entry.Text) || strings.IndexByte(entry.Text, 0) >= 0 {
			p.artifact.UnavailableReason = "binary_or_invalid_utf8"
			return
		}
		p.artifact.addEntry(*entry)
	}
}

func (p *ripgrepPage) result(tc *ToolContext) Result {
	out := strings.Join(p.lines, "\n")
	if len(p.lines) > 0 {
		out += "\n"
	}
	if p.more > 0 {
		out += fmt.Sprintf("... [%d more result(s) — page with offset=%d, or head_limit=0 for all] ...\n", p.more, p.offset+len(p.lines))
	}
	captured := Capture(tc, out)
	p.artifact.Truncated = p.artifact.Truncated || p.offset > 0 || p.more > 0 || captured != out
	return artifactResult(Text(captured), p.artifact)
}

func readRipgrepFiles(out []byte, dir string, page *ripgrepPage) error {
	for len(out) > 0 {
		end := bytes.IndexByte(out, 0)
		if end < 0 {
			return fmt.Errorf("missing filename terminator")
		}
		path := string(out[:end])
		out = out[end+1:]
		page.add(path, &ToolArtifactEntry{Path: filepath.Join(dir, path)})
	}
	return nil
}

func readRipgrepCounts(out []byte, dir string, singleFile bool, page *ripgrepPage) error {
	for len(out) > 0 {
		end := bytes.IndexByte(out, 0)
		if end < 0 {
			return fmt.Errorf("missing filename terminator")
		}
		path := string(out[:end])
		out = out[end+1:]
		end = bytes.IndexByte(out, '\n')
		if end < 0 {
			end = len(out)
		}
		rawCount := string(out[:end])
		count, err := strconv.Atoi(rawCount)
		if err != nil {
			return err
		}
		out = out[min(end+1, len(out)):]
		text := rawCount
		if !singleFile {
			text = path + ":" + rawCount
		}
		page.add(text, &ToolArtifactEntry{Path: filepath.Join(dir, path), Count: &count})
	}
	return nil
}

type ripgrepJSONText struct {
	Text  *string `json:"text"`
	Bytes string  `json:"bytes"`
}

func (s ripgrepJSONText) value() (string, error) {
	if s.Text != nil {
		return *s.Text, nil
	}
	if s.Bytes == "" {
		return "", fmt.Errorf("missing text payload")
	}
	b, err := base64.StdEncoding.DecodeString(s.Bytes)
	return string(b), err
}

func readRipgrepContent(out []byte, dir string, singleFile bool, req ripgrepReq, page *ripgrepPage) error {
	decoder := json.NewDecoder(bytes.NewReader(out))
	lastPath, lastLine := "", 0
	printed := false
	for {
		var event struct {
			Type string `json:"type"`
			Data struct {
				Path         ripgrepJSONText `json:"path"`
				Lines        ripgrepJSONText `json:"lines"`
				LineNumber   int             `json:"line_number"`
				BinaryOffset *int            `json:"binary_offset"`
			} `json:"data"`
		}
		if err := decoder.Decode(&event); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if event.Type == "end" && event.Data.BinaryOffset != nil {
			page.artifact.UnavailableReason = "binary_or_invalid_utf8"
			path, err := event.Data.Path.value()
			if err != nil {
				return err
			}
			text := fmt.Sprintf("binary file matches (found \"\\0\" byte around offset %d)", *event.Data.BinaryOffset)
			if !singleFile {
				text = path + ": " + text
			}
			page.add(text, &ToolArtifactEntry{Path: filepath.Join(dir, path)})
		}
		if event.Type != "match" && event.Type != "context" {
			continue
		}
		path, err := event.Data.Path.value()
		if err != nil {
			return err
		}
		text, err := event.Data.Lines.value()
		if err != nil {
			return err
		}
		if strings.IndexByte(text, 0) >= 0 {
			page.artifact.UnavailableReason = "binary_or_invalid_utf8"
			continue
		}
		line := event.Data.LineNumber
		if line <= 0 {
			return fmt.Errorf("missing line number")
		}
		if printed && (req.before > 0 || req.after > 0) && (lastPath != path || line > lastLine+1) {
			page.add("--", nil)
		}
		separator := ":"
		if event.Type == "context" {
			separator = "-"
		}
		for _, content := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
			prefix := ""
			if !singleFile {
				prefix = path + separator
			}
			if req.showLines {
				prefix += strconv.Itoa(line) + separator
			}
			page.add(prefix+content, &ToolArtifactEntry{Path: filepath.Join(dir, path), Line: line, Text: content})
			lastPath, lastLine, printed = path, line, true
			line++
		}
	}
}
