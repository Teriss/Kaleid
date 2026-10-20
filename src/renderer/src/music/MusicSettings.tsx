import { useEffect, useState } from "react";
import { report, useApp } from "../store";
import { effectControls, effectDefaults, useMusicEffects } from "./effects";

export default function MusicSettings() {
  const sound = useMusicEffects();
  const [quality, setQuality] = useState(
    () => localStorage.getItem("yingjian:audio-quality") || "high",
  );
  const [provider, setProvider] = useState<"openai" | "gemini">("openai");
  const [url, setUrl] = useState("https://api.openai.com/v1/chat/completions"),
    [model, setModel] = useState("");
  const [key, setKey] = useState(""),
    [configured, setConfigured] = useState(false),
    [busy, setBusy] = useState(false);
  const [models, setModels] = useState<
    Awaited<ReturnType<typeof window.music.models>>
  >([]);
  useEffect(() => {
    void window.music
      .aiConfig()
      .then((c) => {
        setProvider(c.provider);
        setUrl(c.url);
        setModel(c.model);
        setConfigured(c.configured);
      })
      .catch(report);
    void window.music.models().then(setModels).catch(report);
  }, []);
  const labels: Record<string, string> = {
    highpass: "高通",
    lowpass: "低通",
    drive: "饱和",
    crush: "位深压缩",
    wow: "磁带抖晃",
    noise: "唱片噪声",
    width: "立体声宽度",
    space: "混响",
    punch: "动态压缩",
  };
  return (
    <>
      <h3>在线音质</h3>
      <div className="settings-group">
        <label className="setting-row">
          <span>优先音质</span>
          <select
            aria-label="在线音质"
            value={quality}
            onChange={(e) => {
              setQuality(e.target.value);
              localStorage.setItem("yingjian:audio-quality", e.target.value);
            }}
          >
            {[
              ["standard", "标准"],
              ["high", "高品质"],
              ["ultra", "超高品质"],
              ["lossless", "无损"],
              ["hires", "Hi-Res"],
            ].map(([value, name]) => (
              <option value={value} key={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">新选歌曲生效，按平台能力与账号权限提供。</p>
      </div>
      <h3>Folia 音效</h3>
      <div className="settings-group">
        <div className="setting-row">
          <strong>启用附加音效</strong>
          <button
            role="switch"
            aria-label="启用附加音效"
            aria-checked={sound.enabled}
            className={`switch ${sound.enabled ? "on" : ""}`}
            onClick={() => sound.set({ enabled: !sound.enabled })}
          >
            <span />
          </button>
        </div>
        {effectControls.map((control) => (
          <label className="setting-row" key={control.id}>
            <span>{labels[control.id]}</span>
            <input
              aria-label={labels[control.id]}
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={sound.effects[control.id]}
              onChange={(e) =>
                sound.set({
                  effects: {
                    ...sound.effects,
                    [control.id]: Number(e.target.value),
                  },
                })
              }
            />
            <output>{sound.effects[control.id]}</output>
          </label>
        ))}
        <button
          className="text-button"
          onClick={() => sound.set({ effects: effectDefaults, enabled: false })}
        >
          重置音效
        </button>
      </div>
      <h3>AI 主题</h3>
      <form
        className="settings-group ai-config"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await window.music.saveAI({ provider, url, model, key });
            setKey("");
            setConfigured(true);
            useApp.getState().notify("AI 配置已加密保存");
          } catch (error) {
            report(error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="setting-row">
          <span>服务</span>
          <select
            aria-label="AI 服务"
            value={provider}
            onChange={(e) => setProvider(e.target.value as any)}
          >
            <option value="openai">OpenAI 兼容服务</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        {provider === "openai" && (
          <>
            <label className="setting-row">
              <span>地址</span>
              <input
                aria-label="AI 服务地址"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className="setting-row">
              <span>模型</span>
              <input
                aria-label="AI 模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
          </>
        )}
        <label className="setting-row">
          <span>API Key</span>
          <input
            aria-label="AI API Key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={configured ? "已保存；留空保留" : "输入密钥"}
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={busy} className="button secondary">
          保存 AI 配置
        </button>
      </form>
      <h3>分析模型</h3>
      <div className="settings-group">
        <p className="muted">
          当前预览版支持下载和校验；分轨与拍点分析尚未接通。
        </p>
        {models.map((m) => (
          <div className="setting-row" key={m.name}>
            <span>
              {m.name}
              <small> {(m.bytes / 1024 / 1024).toFixed(1)} MB</small>
            </span>
            <span>
              {m.installed ? "已安装" : m.downloading ? "正在下载" : "未安装"}
            </span>
            <button
              className="text-button"
              disabled={m.installed || m.downloading}
              onClick={async () => {
                setModels(
                  models.map((row) =>
                    row.name === m.name ? { ...row, downloading: true } : row,
                  ),
                );
                try {
                  await window.music.downloadModel(m.name);
                } catch (error) {
                  report(error);
                } finally {
                  setModels(await window.music.models());
                }
              }}
            >
              下载模型
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
