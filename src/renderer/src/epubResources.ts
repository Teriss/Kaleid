import DOMPurify from "dompurify";
import type Book from "epubjs/types/book";

const ARCHIVE_ORIGIN = "https://epub.invalid";
const URI_ALLOWLIST =
  /^(?:blob:|data:image\/|#|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** Resolve against the ZIP package, never against the renderer's origin. */
export function archivePath(value: string, base = "/") {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return undefined;
  try {
    const url = new URL(value, new URL(base, ARCHIVE_ORIGIN));
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

export class EpubResources {
  private urls = new Map<string, string>();
  private css = new Map<string, string>();
  private disposed = false;

  constructor(private readonly book: Book) {}

  async prepare() {
    const manifest = Object.values(this.book.packaging.manifest) as Array<{
      href: string;
      type: string;
    }>;
    await Promise.all(
      manifest.map(async (item) => {
        const path = archivePath(this.book.resolve(item.href, false));
        if (!path) return;
        if (item.type === "text/css") {
          const text = await this.book.archive.getText(path);
          if (text != null) this.css.set(path, text);
        } else if (
          /^(?:image\/|font\/|application\/(?:font|vnd.ms-opentype))/.test(
            item.type,
          )
        ) {
          const blob = await this.book.archive.getBlob(path, item.type);
          if (blob && !this.disposed)
            this.urls.set(path, URL.createObjectURL(blob));
        }
      }),
    );
    // CSS can reference images, fonts, and other stylesheets in the archive.
    for (const [path, text] of this.css) {
      if (this.disposed) return;
      this.css.set(path, this.cleanCss(text, path));
    }
  }

  private resource(value: string, base: string) {
    if (value.startsWith("blob:") && [...this.urls.values()].includes(value))
      return value;
    if (/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);/i.test(value))
      return value;
    const path = archivePath(value, base);
    return path ? this.urls.get(path) : undefined;
  }

  private cleanCss(css: string, base: string) {
    return css
      .replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;?/gi, "")
      .replace(
        /url\(\s*(["']?)(.*?)\1\s*\)/gi,
        (_all, _quote, value: string) => {
          if (value.startsWith("#")) return `url("${value}")`;
          return `url("${this.resource(value, base) ?? "data:,"}")`;
        },
      );
  }

  sanitize(doc: Document, section: { url: string }, appearance?: string) {
    const base = new URL(section.url, ARCHIVE_ORIGIN).pathname;
    doc
      .querySelectorAll("script,iframe,object,embed,form,base,meta[http-equiv]")
      .forEach((node) => node.remove());
    doc.querySelectorAll("link").forEach((link) => {
      const path = archivePath(link.getAttribute("href") ?? "", base);
      const css = path ? this.css.get(path) : undefined;
      if (
        link.getAttribute("rel")?.toLowerCase() === "stylesheet" &&
        css != null
      ) {
        // srcdoc inherits the app's CSP. Inline sanitized book CSS instead of
        // requiring a weaker global style-src policy for blob stylesheets.
        const style = doc.createElement("style");
        style.textContent = css;
        link.replaceWith(style);
      } else link.remove();
    });
    // Rewrite before DOMPurify so SVG xlink:href and HTML img follow the same policy.
    doc.querySelectorAll("img,image,source,video,audio").forEach((element) => {
      for (const attr of ["src", "href", "xlink:href", "poster"]) {
        const value = element.getAttribute(attr);
        if (value == null) continue;
        const url = this.resource(value, base);
        if (url) element.setAttribute(attr, url);
        else element.removeAttribute(attr);
      }
      element.removeAttribute("srcset");
    });
    doc.querySelectorAll("style").forEach((style) => {
      style.textContent = this.cleanCss(style.textContent ?? "", base);
    });
    doc.querySelectorAll("[style]").forEach((element) => {
      element.setAttribute(
        "style",
        this.cleanCss(element.getAttribute("style") ?? "", base),
      );
    });
    const body = doc.querySelector("body");
    if (!body) throw new Error("EPUB 章节缺少正文");
    DOMPurify.sanitize(body, {
      IN_PLACE: true,
      WHOLE_DOCUMENT: true,
      ALLOWED_URI_REGEXP: URI_ALLOWLIST,
      FORBID_TAGS: [
        "script",
        "iframe",
        "object",
        "embed",
        "form",
        "audio",
        "video",
      ],
      FORBID_ATTR: ["srcdoc"],
    });
    const csp = doc.createElement("meta");
    csp.setAttribute("http-equiv", "Content-Security-Policy");
    csp.setAttribute(
      "content",
      "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; script-src 'none'; base-uri 'none'",
    );
    doc.querySelector("head")?.prepend(csp);
    if (appearance) {
      const style = doc.createElement("style");
      style.id = "kaleid-reader-appearance";
      style.textContent = appearance;
      doc.querySelector("head")?.append(style);
    }
  }

  dispose() {
    this.disposed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.css.clear();
  }
}
