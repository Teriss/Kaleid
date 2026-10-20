import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import type { VideoExportJob } from "../../shared/video";
import { Modal } from "./components";
import { report } from "./store";
import "./video.css";

export default function VideoExportTasks() {
  const [jobs, setJobs] = useState<VideoExportJob[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true,
      received = false;
    const unsubscribe = window.video.onExports((next) => {
      received = true;
      if (live) setJobs(next);
    });
    void window.video
      .exports()
      .then((next) => {
        if (live && !received) setJobs(next);
      })
      .catch(report);
    const show = () => setOpen(true);
    window.addEventListener("video:exports-open", show);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener("video:exports-open", show);
    };
  }, []);
  const count = jobs.filter((job) =>
    ["queued", "running"].includes(job.status),
  ).length;
  return (
    <>
      {jobs.length > 0 && (
        <button className="video-export-launcher" onClick={() => setOpen(true)}>
          <Download size={16} />
          导出任务{count > 0 ? ` · ${count}` : ""}
        </button>
      )}
      {open && (
        <Modal
          title="视频导出任务"
          subtitle="离开播放器后继续处理；任务按顺序执行。"
          close={() => setOpen(false)}
          className="video-export-modal"
        >
          {jobs.length === 0 && (
            <p className="muted">
              暂无导出任务。在视频控制条中选择“截取片段”即可开始。
            </p>
          )}
          {[...jobs].reverse().map((job) => (
            <article className="video-export-job" key={job.id}>
              <strong>
                {job.title} <small>{job.format.toUpperCase()}</small>
              </strong>
              <div className="video-export-status">
                <span>
                  {
                    {
                      queued: "等待导出",
                      running: "正在导出",
                      completed: "已完成",
                      canceled: "已取消",
                      failed: "导出失败",
                    }[job.status]
                  }
                </span>
                <span>{Math.round(job.progress * 100)}%</span>
              </div>
              <progress max={1} value={job.progress} />
              <small className="video-help">{job.output}</small>
              {job.error && (
                <p role="alert" className="video-export-error">
                  {job.error}
                </p>
              )}
              {["queued", "running"].includes(job.status) && (
                <button
                  className="button secondary"
                  onClick={() =>
                    void window.video.cancelExport(job.id).catch(report)
                  }
                >
                  取消导出
                </button>
              )}
              {job.status === "completed" && (
                <button
                  className="button secondary"
                  onClick={() =>
                    void window.video.revealExport(job.id).catch(report)
                  }
                >
                  显示文件位置
                </button>
              )}
            </article>
          ))}
        </Modal>
      )}
    </>
  );
}
