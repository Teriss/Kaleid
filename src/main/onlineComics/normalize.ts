/** Venera exploration pages can be lists, mixed pages or named object/Map sections. */
export function comicSections(raw: any): { title: string; comics: any[] }[] {
  const sections: { title: string; comics: any[] }[] = [];
  const collect = (value: any, title = "") => {
    if (Array.isArray(value)) {
      if (
        value.length &&
        value.every((c) => c && (c.id != null || c.comicId != null))
      )
        sections.push({ title, comics: value });
      else value.forEach((part) => collect(part, title));
    } else if (value && typeof value === "object") {
      if (Array.isArray(value.comics))
        collect(value.comics, value.title || title);
      else if (value.data != null) collect(value.data, title);
      else
        for (const [name, part] of value.$map || Object.entries(value))
          if (Array.isArray(part) || (part && typeof part === "object"))
            collect(part, String(name));
    }
  };
  collect(raw);
  return sections;
}
