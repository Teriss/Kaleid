import { useEffect, useState } from "react";
import { Modal } from "../components";
import { report, useApp } from "../store";
import { invalidateMusicPages } from "./catalog";
export default function NavidromeSettings({ close }: { close(): void }) {
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.music
      .navidromeConfig()
      .then((c) => {
        if (c) {
          setUrl(c.url);
          setUsername(c.username);
        }
      })
      .catch(report);
  }, []);
  return (
    <Modal title="Navidrome" close={close}>
      <form
        className="navidrome-config"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await window.music.saveNavidrome({ url, username, password });
            await window.music.navidrome("ping");
            invalidateMusicPages();
            useApp.getState().touch();
            close();
          } catch (error) {
            report(error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          服务器地址
          <input
            required
            type="url"
            aria-label="Navidrome 服务器地址"
            placeholder="https://music.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label>
          用户名
          <input
            required
            aria-label="Navidrome 用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            aria-label="Navidrome 密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="留空保留已保存密码"
            autoComplete="current-password"
          />
        </label>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? "正在连接…" : "保存并连接"}
        </button>
      </form>
    </Modal>
  );
}
