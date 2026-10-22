import MediaShowcase, {
  ShowcaseCover,
  type ShowcaseFaceProps,
} from "./MediaShowcase";
import type { LayoutProps } from "./shared";
import { time } from "../store";

function RecordFace({ item }: ShowcaseFaceProps) {
  return (
    <span className="record-object">
      {!item?.kind && (
        <span className="record-disc" aria-hidden="true">
          <span className="record-label">
            <i />
            {item?.title.slice(0, 3) ?? "33"}
          </span>
        </span>
      )}
      <span className="record-jacket">
        <ShowcaseCover item={item} />
        <span className="record-sleeve-edge" />
      </span>
      <span className="record-edition" aria-hidden="true">
        {item?.kind ? "COLLECTION" : "STEREO / 33⅓"}
      </span>
    </span>
  );
}
export default function RecordCrate(props: LayoutProps) {
  return (
    <MediaShowcase
      {...props}
      kind="recordCrate"
      title="唱片箱"
      eyebrow="01 / RECORD COLLECTION"
      Face={RecordFace}
      metadata={(item) =>
        [
          item.artist || "未知歌手",
          item.album,
          item.duration ? time(item.duration) : item.ext.toUpperCase(),
        ]
          .filter(Boolean)
          .join(" · ")
      }
    />
  );
}
