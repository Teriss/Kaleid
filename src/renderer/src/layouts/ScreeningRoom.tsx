import MediaShowcase, {
  ShowcaseCover,
  type ShowcaseFaceProps,
} from "./MediaShowcase";
import type { LayoutProps } from "./shared";
import { time } from "../store";
import { videoProgress } from "./showcaseModel";

function ScreenFace({ item }: ShowcaseFaceProps) {
  const progress = item && !item.kind ? videoProgress(item) : 0;
  return (
    <span className="screen-object">
      <ShowcaseCover item={item} />
      {progress > 0 && (
        <span
          className="screen-progress"
          aria-label={`观看进度 ${Math.round(progress * 100)}%`}
        >
          <i style={{ width: `${progress * 100}%` }} />
        </span>
      )}
      <span className="screen-rim" aria-hidden="true" />
    </span>
  );
}
export default function ScreeningRoom(props: LayoutProps) {
  return (
    <MediaShowcase
      {...props}
      kind="screeningRoom"
      title="放映厅"
      eyebrow="02 / PRIVATE SCREENING"
      Face={ScreenFace}
      metadata={(item) =>
        [
          item.duration ? time(item.duration) : item.ext.toUpperCase(),
          item.progress?.completed
            ? "已看完"
            : videoProgress(item) > 0
              ? `已看 ${Math.round(videoProgress(item) * 100)}%`
              : "尚未观看",
        ].join(" · ")
      }
    />
  );
}
