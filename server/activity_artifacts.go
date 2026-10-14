package server

import (
	"encoding/json"

	"github.com/Autumn-27/artex/db"
)

// Lists and SSE carry artifact identity, never file snapshots or search results.
// Leave unrelated metadata (including llm_transition) intact.
func activityMetadataSummary(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return nil
	}
	var artifact map[string]json.RawMessage
	if err := json.Unmarshal(metadata["tool_artifact"], &artifact); err != nil || artifact == nil {
		return raw
	}
	if entries, ok := artifact["entries"]; ok {
		var items []json.RawMessage
		if json.Unmarshal(entries, &items) == nil {
			if _, exists := artifact["entry_count"]; !exists {
				artifact["entry_count"], _ = json.Marshal(len(items))
			}
		}
	}
	delete(artifact, "before")
	delete(artifact, "after")
	delete(artifact, "entries")
	metadata["tool_artifact"], _ = json.Marshal(artifact)
	result, err := json.Marshal(metadata)
	if err != nil {
		return nil
	}
	return result
}

type activityDetailResponse struct {
	Detail   string          `json:"detail"`
	Metadata json.RawMessage `json:"metadata"`
}

func activityDetailPayload(a *db.Activity) activityDetailResponse {
	result := activityDetailResponse{Metadata: json.RawMessage(`{}`)}
	if a != nil {
		result.Detail = a.Detail
		if len(a.Metadata) > 0 {
			result.Metadata = a.Metadata
		}
	}
	return result
}
