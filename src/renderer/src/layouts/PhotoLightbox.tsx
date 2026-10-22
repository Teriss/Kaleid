import MediaShowcase, {
  ShowcaseCover,
  type ShowcaseFaceProps,
} from "./MediaShowcase";
import type { LayoutProps } from "./shared";

function PhotoFace({ item }: ShowcaseFaceProps) {
  return (
    <span className="photo-object">
      <ShowcaseCover item={item} />
      <span className="photo-print-code" aria-hidden="true">
        {item?.kind ? "COLLECTION" : "KALEID / CONTACT PRINT"}
      </span>
    </span>
  );
}
export default function PhotoLightbox(props: LayoutProps) {
  return (
    <MediaShowcase
      {...props}
      kind="photoLightbox"
      title="摄影灯箱"
      eyebrow="03 / CONTACT PRINTS"
      Face={PhotoFace}
      metadata={(item) =>
        [
          item.ext.toUpperCase(),
          item.width && item.height ? `${item.width} × ${item.height}` : "图片",
          item.favorite ? "已收藏" : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      }
    />
  );
}
