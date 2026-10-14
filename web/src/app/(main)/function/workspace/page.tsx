"use client";

import * as React from "react";
import {
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  HardDriveIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { WorkspaceEntry, WorkspaceFile } from "@/lib/types";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type EditState = {
  session: number;
  file: WorkspaceFile;
  content: string;
  savedContent: string;
  dirty: boolean;
  saving: boolean;
};

export default function WorkspacePage() {
  const [path, setPath] = React.useState("");
  const [entries, setEntries] = React.useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [edit, setEdit] = React.useState<EditState | null>(null);
  const editRef = React.useRef(edit);
  editRef.current = edit;
  const editorSession = React.useRef(0);
  const savedSnapshot = React.useRef<{ session: number; content: string } | null>(null);
  const [closeRequested, setCloseRequested] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const loadRequest = React.useRef(0);
  const draftStorageFailed = React.useRef(false);
  const [mkdirOpen, setMkdirOpen] = React.useState(false);
  const [mkdirName, setMkdirName] = React.useState("");
  const uploadRef = React.useRef<HTMLInputElement>(null);
  const editorRef = React.useRef<HTMLTextAreaElement>(null);

  const load = React.useCallback(
    (p: string) => {
      const request = ++loadRequest.current;
      setLoading(true);
      setLoadError("");
      api
        .workspaceList(p)
        .then((r) => {
          if (request !== loadRequest.current) return;
          setEntries(r.entries);
          setPath(r.path);
        })
        .catch((e) => { if (request === loadRequest.current) setLoadError(`读取目录失败：${(e as Error).message}`); })
        .finally(() => { if (request === loadRequest.current) setLoading(false); });
    },
    [],
  );

  React.useEffect(() => {
    load("");
  }, [load]);

  // Keep drafts through in-app navigation; a reload/closed tab still gets the
  // browser's unsaved-change warning. Storage failure must not block editing.
  React.useEffect(() => {
    if (!edit || edit.session !== editorSession.current) return;
    try {
      const key = `artex_workspace_draft:${edit.file.path}`;
      const saved = savedSnapshot.current?.session === edit.session ? savedSnapshot.current.content : edit.savedContent;
      if (edit.content !== saved) sessionStorage.setItem(key, edit.content);
      else sessionStorage.removeItem(key);
    } catch {
      if (!draftStorageFailed.current) toast.error("无法暂存草稿，请保存修改后再离开此页");
      draftStorageFailed.current = true;
    }
  }, [edit]);

  React.useEffect(() => {
    if (!edit?.dirty && !edit?.saving) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const leaving = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const current = editRef.current;
      if (current?.saving || (current?.dirty && !window.confirm(draftStorageFailed.current ? "草稿暂存不可用，离开将丢失未保存的修改。是否离开？" : "文件有未保存的修改。离开后可重新打开文件恢复草稿，是否离开？"))) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", leaving, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", leaving, true); };
  }, [edit?.dirty, edit?.saving]);

  const crumbs = React.useMemo(() => {
    const parts = path ? path.split("/") : [];
    const acc: { name: string; path: string }[] = [{ name: "工作空间", path: "" }];
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      acc.push({ name: part, path: cur });
    }
    return acc;
  }, [path]);

  const openFile = (e: WorkspaceEntry) => {
    const session = ++editorSession.current;
    api
      .workspaceRead(e.path)
      .then((f) => {
        if (session !== editorSession.current) return;
        const savedContent = f.content ?? "";
        savedSnapshot.current = { session, content: savedContent };
        let content = savedContent;
        try { content = sessionStorage.getItem(`artex_workspace_draft:${f.path}`) ?? savedContent; } catch { /* Editing still works without storage. */ }
        setEdit({ session, file: f, content, savedContent, dirty: content !== savedContent, saving: false });
        if (content !== savedContent) toast.info("已恢复此文件的未保存草稿");
      })
      .catch((err) => toast.error(`打开文件失败：${(err as Error).message}`));
  };

  const saveFile = async () => {
    const snapshot = editRef.current;
    if (!snapshot || snapshot.saving) return false;
    setEdit((cur) => cur?.session === snapshot.session ? { ...cur, saving: true } : cur);
    try {
      await api.workspaceWrite(snapshot.file.path, snapshot.content);
      if (editRef.current?.session === snapshot.session) savedSnapshot.current = { session: snapshot.session, content: snapshot.content };
      const fullySaved = editRef.current?.session === snapshot.session && editRef.current.content === snapshot.content;
      setEdit((cur) => cur?.session === snapshot.session
        ? { ...cur, savedContent: snapshot.content, dirty: cur.content !== snapshot.content, saving: false }
        : cur);
      if (fullySaved) {
        try { sessionStorage.removeItem(`artex_workspace_draft:${snapshot.file.path}`); } catch { /* Saved on the server. */ }
      }
      toast.success(fullySaved ? "已保存" : "已保存提交的内容，后续修改仍未保存");
      load(path);
      return fullySaved;
    } catch (err) {
      toast.error(`保存失败：${(err as Error).message}`);
      setEdit((cur) => cur?.session === snapshot.session ? { ...cur, saving: false } : cur);
      return false;
    }
  };

  const requestClose = () => {
    if (editRef.current?.saving) { toast.info("正在保存，请稍候再关闭"); return; }
    if (editRef.current?.dirty) setCloseRequested(true);
    else setEdit(null);
  };

  const discardAndClose = () => {
    editorSession.current += 1;
    if (editRef.current) {
      try { sessionStorage.removeItem(`artex_workspace_draft:${editRef.current.file.path}`); } catch { /* No stored draft to discard. */ }
    }
    setCloseRequested(false);
    setEdit(null);
  };

  const del = (e: WorkspaceEntry) => {
    if (!window.confirm(`确认删除 ${e.dir ? "目录" : "文件"} “${e.name}”？${e.dir ? "（含其下所有内容）" : ""}`)) return;
    api
      .workspaceDelete(e.path)
      .then(() => {
        toast.success("已删除");
        load(path);
      })
      .catch((err) => toast.error(`删除失败：${(err as Error).message}`));
  };

  const doUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    api
      .workspaceUpload(path, Array.from(files))
      .then((r) => {
        toast.success(`已上传 ${r.uploaded} 个文件`);
        load(path);
      })
      .catch((err) => toast.error(`上传失败：${(err as Error).message}`))
      .finally(() => {
        if (uploadRef.current) uploadRef.current.value = "";
      });
  };

  const doMkdir = () => {
    const name = mkdirName.trim();
    if (!name) return;
    const target = path ? `${path}/${name}` : name;
    api
      .workspaceMkdir(target)
      .then(() => {
        toast.success("已创建目录");
        setMkdirOpen(false);
        setMkdirName("");
        load(path);
      })
      .catch((err) => toast.error(`创建失败：${(err as Error).message}`));
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">工作空间</h1>
      {/* 头部：面包屑 + 操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="文件路径" className="flex min-w-0 items-center gap-1 text-sm">
          <HardDriveIcon className="text-muted-foreground mr-1 size-4 shrink-0" />
          {crumbs.map((c, i) => (
            <React.Fragment key={c.path}>
              {i > 0 && <span className="text-muted-foreground">/</span>}
              <button
                type="button"
                onClick={() => load(c.path)}
                className={cn(
                  "max-w-[160px] truncate rounded px-1.5 py-0.5 hover:bg-accent",
                  i === crumbs.length - 1 ? "text-foreground font-medium" : "text-muted-foreground",
                )}
              >
                {c.name}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setMkdirOpen(true)}>
            <FolderPlusIcon /> 新建文件夹
          </Button>
          <Button variant="outline" size="sm" onClick={() => uploadRef.current?.click()}>
            <UploadIcon /> 上传
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => load(path)} title="刷新">
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <input
            ref={uploadRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => doUpload(e.target.files)}
          />
        </div>
      </div>

      {loadError && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
        <span>{loadError}{entries.length > 0 ? "（保留上次结果）" : ""}</span>
        <Button variant="outline" size="sm" onClick={() => load(path)}>重试</Button>
      </div>}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead className="w-28 text-right">大小</TableHead>
                <TableHead className="w-40">修改时间</TableHead>
                <TableHead className="w-24 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 && !loadError && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-10 text-center text-sm">
                    {loading ? "加载中…" : "空目录"}
                  </TableCell>
                </TableRow>
              )}
              {entries.map((e) => (
                <TableRow key={e.path}>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => (e.dir ? load(e.path) : openFile(e))}
                      className="flex items-center gap-2 text-left hover:underline"
                    >
                      {e.dir ? (
                        <FolderIcon className="size-4 shrink-0 text-blue-500" />
                      ) : (
                        <FileIcon className="text-muted-foreground size-4 shrink-0" />
                      )}
                      <span className="truncate font-mono text-sm">{e.name}</span>
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right font-mono text-xs">
                    {e.dir ? "—" : fmtSize(e.size)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{fmtTime(e.mtime)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {!e.dir && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          title="下载"
                          onClick={() => api.workspaceDownload(e.path).catch((err) => toast.error(`下载失败：${(err as Error).message}`))}
                        >
                          <DownloadIcon className="size-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive size-7"
                        title="删除"
                        onClick={() => del(e)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 文件查看 / 编辑 */}
      <Sheet open={edit !== null} onOpenChange={(o) => !o && requestClose()}>
        <SheetContent side="right" className="flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
          {edit && (
            <>
              <SheetHeader className="border-b p-4">
                <SheetTitle className="flex items-center gap-2 truncate font-mono text-sm">
                  <FileIcon className="size-4 shrink-0" />
                  <span className="truncate" title={edit.file.path}>
                    {edit.file.path}
                  </span>
                </SheetTitle>
                <SheetDescription>{fmtSize(edit.file.size)} · 编辑后请保存，未保存草稿会在本标签页保留</SheetDescription>
              </SheetHeader>

              {edit.file.binary || edit.file.too_large ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                  <p className="text-muted-foreground text-sm">
                    {edit.file.too_large ? "文件过大，不支持在线预览/编辑。" : "二进制文件，不支持在线预览/编辑。"}
                  </p>
                  <Button variant="outline" onClick={() => api.workspaceDownload(edit.file.path).catch((err) => toast.error(`下载失败：${(err as Error).message}`))}>
                    <DownloadIcon /> 下载文件
                  </Button>
                </div>
              ) : (
                <>
                  <div className="min-h-0 flex-1 p-3">
                    <Textarea
                      ref={editorRef}
                      aria-label={`文件内容：${edit.file.path}`}
                      value={edit.content}
                      onChange={(ev) => {
                        const content = ev.target.value;
                        setEdit((cur) => cur ? { ...cur, content, dirty: content !== cur.savedContent } : cur);
                      }}
                      spellCheck={false}
                      className="h-full min-h-[50vh] resize-none font-mono text-xs leading-relaxed"
                    />
                  </div>
                  <SheetFooter className="flex-row items-center justify-between border-t p-3">
                    <span role="status" className="text-muted-foreground text-xs">{edit.saving ? "正在保存提交的内容…" : edit.dirty ? "未保存的修改" : "已同步"}</span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => api.workspaceDownload(edit.file.path).catch((err) => toast.error(`下载失败：${(err as Error).message}`))}
                      >
                        <DownloadIcon /> 下载
                      </Button>
                      <Button onClick={() => void saveFile()} disabled={!edit.dirty || edit.saving}>
                        <SaveIcon /> {edit.saving ? "保存中…" : "保存"}
                      </Button>
                    </div>
                  </SheetFooter>
                </>
              )}
            </>
          )}
      <AlertDialog open={closeRequested} onOpenChange={setCloseRequested}>
        <AlertDialogContent onCloseAutoFocus={(event) => { event.preventDefault(); editorRef.current?.focus(); }}>
          <AlertDialogHeader>
            <AlertDialogTitle>保存文件修改？</AlertDialogTitle>
            <AlertDialogDescription>“{edit?.file.path}”有未保存的修改。放弃修改会清除此文件的草稿。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={edit?.saving} onClick={() => setCloseRequested(false)}>继续编辑</Button>
            <Button variant="destructive" disabled={edit?.saving} onClick={discardAndClose}>放弃修改</Button>
            <Button disabled={edit?.saving} onClick={async () => { if (await saveFile()) { setCloseRequested(false); setEdit(null); } }}>保存并关闭</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

        </SheetContent>
      </Sheet>


      {/* 新建文件夹 */}
      <Dialog open={mkdirOpen} onOpenChange={setMkdirOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="文件夹名称"
            autoFocus
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doMkdir()}
            placeholder="文件夹名称"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMkdirOpen(false)}>
              取消
            </Button>
            <Button onClick={doMkdir} disabled={!mkdirName.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
