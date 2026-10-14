package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Autumn-27/artex/db"
	"github.com/Autumn-27/norma/agentcore"
	"github.com/Autumn-27/norma/llm"
	"github.com/Autumn-27/norma/permission"
	"github.com/Autumn-27/norma/tool"
)

func TestCaptureRunPersistsToolArtifactOutsideResultText(t *testing.T) {
	for _, nonStreaming := range []bool{false, true} {
		t.Run(map[bool]string{false: "streaming", true: "nonstreaming"}[nonStreaming], func(t *testing.T) {
			dir := t.TempDir()
			const before = "BEFORE_ONLY_IN_HOST_METADATA"
			if err := os.WriteFile(filepath.Join(dir, "target.txt"), []byte(before), 0600); err != nil {
				t.Fatal(err)
			}
			turn := 0
			provider := captureUsageProvider{stream: func(_ context.Context, yield func(llm.StreamEvent, error) bool) {
				turn++
				events := []llm.StreamEvent{{Type: llm.SETextDelta, Text: "done"}, {Type: llm.SEMessageDelta, StopReason: "end_turn"}, {Type: llm.SEMessageStop}}
				if turn == 1 {
					events = []llm.StreamEvent{
						{Type: llm.SEToolUseStart, ToolID: "write-artifact", ToolName: "Write"},
						{Type: llm.SEToolInputJSON, Text: `{"file_path":"target.txt","content":"after"}`},
						{Type: llm.SEMessageDelta, StopReason: "tool_use"}, {Type: llm.SEMessageStop},
					}
				}
				for _, event := range events {
					if !yield(event, nil) {
						return
					}
				}
			}}
			var result *db.Activity
			_, _, err := captureRun(t.Context(), agentcore.Options{Provider: provider, Tools: []tool.CoreTool{tool.NewWrite()},
				WorkingDir: dir, PermissionMode: permission.ModeBypass, NonStreaming: nonStreaming, MaxTurns: 3}, "write", func(a db.Activity) {
				if a.Kind == "tool_result" {
					result = &a
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			if result == nil {
				t.Fatal("no tool result captured")
			}
			var metadata struct {
				Artifact *tool.ToolArtifact `json:"tool_artifact"`
			}
			if err := json.Unmarshal(result.Metadata, &metadata); err != nil {
				t.Fatal(err)
			}
			if metadata.Artifact == nil || metadata.Artifact.Before == nil || *metadata.Artifact.Before != before || metadata.Artifact.After == nil || *metadata.Artifact.After != "after" {
				t.Fatalf("snapshot lost from activity metadata: %s", result.Metadata)
			}
			if result.ToolUseID != "write-artifact" || result.Tool != "Write" || result.IsError || strings.Contains(result.Detail, before) || strings.Contains(result.Summary, before) {
				t.Fatalf("wrong result record: %+v", result)
			}
		})
	}
}
