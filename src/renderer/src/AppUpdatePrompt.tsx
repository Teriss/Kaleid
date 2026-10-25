import { useEffect, useState } from "react";
import { Check, Download, RefreshCw } from "lucide-react";
import type { AppUpdateState } from "../../shared/types";
import { Modal } from "./components";
import { act } from "./store";

function promptsForUpdate(state: AppUpdateState | undefined) {
  return Boolean(
    state &&
      (state.status === "available" ||
        state.status === "downloading" ||
        state.status === "downloaded" ||
        (state.status === "error" && state.version)),
  );
}

export default function AppUpdatePrompt() {
  const [state, setState] = useState<AppUpdateState>();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let live = true;
    const unsubscribe = window.media.onUpdateState((next) => {
      if (live) setState(next);
    });
    void window.media.updateState().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (promptsForUpdate(state)) setVisible(true);
    else if (state?.status === "ignored" || state?.status === "not-available")
      setVisible(false);
  }, [state]);

  if (!visible || !state) return null;

  const ignore = () =>
    void act(async () => {
      if (!state.version) return;
      await window.media.ignoreUpdate(state.version);
      setVisible(false);
    });
  const download = () =>
    void act(async () => setState(await window.media.downloadUpdate()));
  const install = () =>
    void act(() => window.media.installUpdate());

  return (
    <Modal
      title={state.status === "downloaded" ? "更新已准备好" : "发现更新"}
      close={() => setVisible(false)}
      className="app-update-modal"
      dismissible={false}
    >
      <div className="app-update-content">
        {state.status === "downloading" ? (
          <>
            <p>正在下载 Kaleid {state.version}</p>
            <progress
              max={100}
              value={state.percent || 0}
              aria-label="更新下载进度"
            />
            <small>{Math.floor(state.percent || 0)}%</small>
          </>
        ) : state.status === "downloaded" ? (
          <>
            <p>Kaleid {state.version} 已下载完成，安装需要重启应用。</p>
            <div className="app-update-actions">
              <button
                className="button secondary"
                onClick={() => setVisible(false)}
              >
                稍后安装
              </button>
              <button className="button primary" onClick={install}>
                <Check size={15} />立即安装
              </button>
            </div>
          </>
        ) : state.status === "error" ? (
          <>
            <p role="status">{state.message || "更新下载失败"}</p>
            <div className="app-update-actions">
              <button className="button secondary" onClick={ignore}>
                忽略本次更新
              </button>
              <button className="button primary" onClick={download}>
                <RefreshCw size={15} />重试
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Kaleid {state.currentVersion} → {state.version}
            </p>
            <div className="app-update-actions">
              <button className="button secondary" onClick={ignore}>
                忽略本次更新
              </button>
              <button className="button primary" onClick={download}>
                <Download size={15} />更新
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
