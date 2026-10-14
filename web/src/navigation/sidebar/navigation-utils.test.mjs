import { getActiveNavUrl, getNavigationArea, isWorkspaceUrl, normalizeNavPath } from "./navigation-utils.ts";
import assert from "node:assert/strict";
import test from "node:test";

test("paths ignore search and hash, decode labels, and normalize trailing slashes", () => {
  assert.equal(normalizeNavPath("/function/tasks///?status=running#details"), "/function/tasks");
  assert.equal(normalizeNavPath("/chat/%E4%B8%AD%E6%96%87/"), "/chat/中文");
  assert.equal(normalizeNavPath("/?tab=home"), "/");
  assert.equal(normalizeNavPath("/"), "/");
  assert.equal(normalizeNavPath("/chat/%E0%A4%A/"), "/chat/%E0%A4%A");
});

test("system navigation recognizes complete path segments", () => {
  for (const path of ["/system", "/system/", "/system/agents/123/?tab=detail", "/%73ystem/settings"]) {
    assert.equal(getNavigationArea(path), "system", path);
  }
  for (const path of ["/chat", "/function/tasks", "/systematic", "/systems/logs", "/"]) {
    assert.equal(getNavigationArea(path), "workspace", path);
  }
});

test("detail pages select a parent while neighboring interception routes select only the longest match", () => {
  const urls = Object.freeze([
    "/system/intercept",
    "/system/intercept/assets",
    "/system/intercept/approvals",
    "/function/tasks",
  ]);
  assert.equal(getActiveNavUrl("/function/tasks/123/", urls), "/function/tasks");
  assert.equal(getActiveNavUrl("/system/intercept/assets/42/?view=detail", urls), "/system/intercept/assets");
  assert.equal(getActiveNavUrl("/system/intercept/approvals/", urls), "/system/intercept/approvals");
  assert.equal(getActiveNavUrl("/system/intercept/rules", urls), "/system/intercept");
  assert.equal(getActiveNavUrl("/function/tasks-other", urls), undefined);
  assert.equal(getActiveNavUrl("/chat", urls), undefined);
  assert.equal(getActiveNavUrl("/", ["/"]), "/");
  assert.equal(getActiveNavUrl("/chat", ["/"]), undefined);
});

test("active navigation uses normalized candidates without changing their original URLs", () => {
  assert.equal(getActiveNavUrl("/chat/中文/", ["/chat/", "/chat/%E4%B8%AD%E6%96%87/"]), "/chat/%E4%B8%AD%E6%96%87/");
  assert.equal(getActiveNavUrl("/chat/", []), undefined);
});

test("return links accept workspace routes and preserve search and fragment in the caller", () => {
  for (const url of ["/chat", "/chat/123/", "/dashboard/?tab=tasks", "/function/tasks/123?filter=active#run"]) {
    assert.equal(isWorkspaceUrl(url), true, url);
  }
  for (const url of ["/system/settings", "/functionality", "/dashboard-old", "/chats", "/"]) {
    assert.equal(isWorkspaceUrl(url), false, url);
  }
});

test("return links reject external URLs and browser-normalized escapes outside the workspace", () => {
  for (const url of [
    "https://example.com/chat",
    "//example.com/chat",
    "chat/123",
    "javascript:alert(1)",
    "/%2fexample.com/chat",
    "/chat/../system/settings",
    "/chat/%2e%2e/system/settings",
    "/chat/%5c..%5csystem/settings",
    "/chat/\u0009../system/settings",
  ]) {
    assert.equal(isWorkspaceUrl(url), false, url);
  }
});
