package harness

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Autumn-27/norma/hook"
	"github.com/Autumn-27/norma/llm"
	"github.com/Autumn-27/norma/permission"
	"github.com/Autumn-27/norma/tool"
)

func TestToolArtifactFollowsExecutedInputAndStaysOutsideMessages(t *testing.T) {
	for _, nonStreaming := range []bool{false, true} {
		t.Run(map[bool]string{false: "streaming", true: "nonstreaming"}[nonStreaming], func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "actual.txt")
			const before = "PRIVATE_BEFORE_SNAPSHOT_SENTINEL"
			if err := os.WriteFile(path, []byte(before), 0600); err != nil {
				t.Fatal(err)
			}
			hooks := hook.NewRegistry().On(hook.PreToolUse, func(_ context.Context, event hook.Event) hook.Result {
				return hook.Result{UpdatedInput: json.RawMessage(`{"file_path":"actual.txt","content":"executed replacement"}`)}
			})
			input := `{"file_path":"requested.txt","content":"requested replacement"}`
			stream := &scriptedModel{turns: [][]llm.StreamEvent{toolTurn("write", "Write", input), textTurn("done")}}
			sync := &scriptedSyncModel{turns: []syncTurn{syncToolTurn("write", "Write", input), syncTextTurn("done")}}
			in := QueryInput{Messages: []llm.Message{llm.UserText("write the file")}, Tools: tool.NewRegistry(tool.NewWrite()),
				PermissionMode: permission.ModeBypass, WorkingDir: dir, NonStreaming: nonStreaming, Hooks: hooks}
			var artifact *tool.ToolArtifact
			var terminal *Terminal
			for event, err := range Query(t.Context(), in, QueryDeps{CallModel: stream.call, CallModelSync: sync.call}) {
				if err != nil {
					t.Fatal(err)
				}
				if event.Kind == KindToolResult {
					artifact = event.ToolArtifact
					encoded, _ := json.Marshal(event.ToolResult)
					if strings.Contains(string(encoded), before) || strings.Contains(string(encoded), "tool_artifact") {
						t.Fatalf("snapshot leaked into tool_result: %s", encoded)
					}
				}
				if event.Kind == KindResult {
					terminal = event.Terminal
				}
			}
			if artifact == nil || artifact.Path != path || artifact.Before == nil || *artifact.Before != before || artifact.After == nil || *artifact.After != "executed replacement" {
				t.Fatalf("metadata reflects requested instead of executed input: %+v", artifact)
			}
			if terminal == nil {
				t.Fatal("no terminal event")
			}
			encoded, _ := json.Marshal(terminal.Messages)
			if strings.Contains(string(encoded), before) || strings.Contains(string(encoded), "snapshot_available") {
				t.Fatalf("snapshot leaked into model history: %s", encoded)
			}
			if _, err := os.Stat(filepath.Join(dir, "requested.txt")); !os.IsNotExist(err) {
				t.Fatalf("original path was changed: %v", err)
			}
		})
	}
}

func TestDeniedToolHasNoArtifact(t *testing.T) {
	model := &scriptedModel{turns: [][]llm.StreamEvent{
		toolTurn("denied", "Write", `{"file_path":"denied.txt","content":"bad"}`), textTurn("done"),
	}}
	for event, err := range Query(t.Context(), QueryInput{Messages: []llm.Message{llm.UserText("plan only")},
		Tools: tool.NewRegistry(tool.NewWrite()), PermissionMode: permission.ModePlan, WorkingDir: t.TempDir()}, QueryDeps{CallModel: model.call}) {
		if err != nil {
			t.Fatal(err)
		}
		if event.Kind == KindToolResult && (event.ToolArtifact != nil || !event.ToolResult.IsError) {
			t.Fatalf("denied call emitted an artifact: %+v", event)
		}
	}
}

func TestToolArtifactUsesPermissionRewrittenInput(t *testing.T) {
	dir := t.TempDir()
	model := &scriptedSyncModel{turns: []syncTurn{
		syncToolTurn("permission", "Write", `{"file_path":"requested.txt","content":"requested"}`), syncTextTurn("done"),
	}}
	in := QueryInput{Messages: []llm.Message{llm.UserText("write")}, Tools: tool.NewRegistry(tool.NewWrite()),
		PermissionMode: permission.ModeDefault, WorkingDir: dir, NonStreaming: true,
		CanUseTool: func(context.Context, string, json.RawMessage, permission.Context) permission.Decision {
			return permission.Decision{Behavior: permission.Allow, UpdatedInput: json.RawMessage(`{"file_path":"allowed.txt","content":"allowed"}`)}
		},
	}
	var artifact *tool.ToolArtifact
	for event, err := range Query(t.Context(), in, QueryDeps{CallModelSync: model.call}) {
		if err != nil {
			t.Fatal(err)
		}
		if event.Kind == KindToolResult {
			artifact = event.ToolArtifact
		}
	}
	if artifact == nil || artifact.Path != filepath.Join(dir, "allowed.txt") || artifact.After == nil || *artifact.After != "allowed" {
		t.Fatalf("permission-rewritten input lost: %+v", artifact)
	}
}
