import { describe, expect, it } from "vitest";
import { epubProgress, ReaderNavigation, ReaderWheelSequence, pageScrollTarget } from "../../src/shared/readerNavigation";
import { archivePath } from "../../src/renderer/src/epubResources";
import { ReaderBoundaryWheel } from "../../src/shared/readerNavigation";

describe("chapter boundary wheel input", () => {
  it("accepts a small next wheel without a distance threshold", () => {
    const wheel = new ReaderBoundaryWheel();
    expect(wheel.accept(10, 1)).toBe(true);
    expect(wheel.accept(20, 1)).toBe(true);
  });
  it("holds one inertia burst and resumes after 160ms idle", () => {
    const wheel = new ReaderBoundaryWheel();
    wheel.hold(1000, 1);
    for (let now = 1020; now < 1500; now += 20) expect(wheel.accept(now, 1)).toBe(false);
    expect(wheel.accept(1640, 1)).toBe(true);
  });
  it("allows immediate reversal and explicit seeking", () => {
    const wheel = new ReaderBoundaryWheel();
    wheel.hold(1000, 1);
    expect(wheel.accept(1010, -1)).toBe(true);
    wheel.hold(1020, -1);
    wheel.clear();
    expect(wheel.accept(1030, -1)).toBe(true);
  });
});

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("reader session navigation", () => {
  it("runs one engine action and retains only the latest pending intent", async () => {
    const called: number[] = [];
    let release!: () => void;
    const navigation = new ReaderNavigation(() => {});
    navigation.submit(async () => { called.push(1); await new Promise<void>((resolve) => { release = resolve; }); });
    navigation.submit(async () => { called.push(2); });
    navigation.submit(async () => { called.push(3); });
    expect(called).toEqual([1]);
    release();
    await tick();
    expect(called).toEqual([1, 3]);
    await tick();
    expect(navigation.busy).toBe(false);
  });

  it("a newer jump invalidates a stale failure and replaces pending pages", async () => {
    const errors: unknown[] = [];
    const called: string[] = [];
    let reject!: (error: unknown) => void;
    const navigation = new ReaderNavigation((error) => errors.push(error));
    navigation.submit(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    navigation.submit(async () => { called.push("page"); });
    navigation.submit(async () => { called.push("jump"); }, true);
    reject(new Error("stale"));
    await tick();
    expect(called).toEqual(["jump"]);
    expect(errors).toEqual([]);
  });

  it("releases the navigation lock after an error", async () => {
    const errors: unknown[] = [];
    const navigation = new ReaderNavigation((error) => errors.push(error));
    navigation.submit(async () => { throw new Error("load failed"); });
    await tick();
    expect(navigation.busy).toBe(false);
    let moved = false;
    navigation.submit(async () => { moved = true; });
    await tick();
    expect(moved).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("does not run old pending work after the session is closed", async () => {
    let release!: () => void;
    let moved = false;
    const navigation = new ReaderNavigation(() => {});
    navigation.submit(() => new Promise<void>((resolve) => { release = resolve; }));
    navigation.submit(async () => { moved = true; });
    navigation.dispose();
    release();
    await tick();
    expect(moved).toBe(false);
  });

  it("accepts sustained wheel input every 100ms across iframe replacements", () => {
    const sequence = new ReaderWheelSequence();
    expect(sequence.accept(1000)).toBe(true);
    for (let at = 1020; at < 1100; at += 20) expect(sequence.accept(at)).toBe(false);
    expect(sequence.accept(1100)).toBe(true);
    expect(sequence.accept(1300)).toBe(true);
    expect(sequence.accept(1600)).toBe(true);
  });

  it("reverses immediately and expires queued wheel input without affecting buttons", () => {
    const wheel = new ReaderWheelSequence();
    expect(wheel.accept(1000, 1)).toBe(true);
    expect(wheel.accept(1020, -1)).toBe(true);
    expect(wheel.current(1040, 1)).toBe(false);
    expect(wheel.accept(1040, -1)).toBe(false);
    expect(wheel.current(1140, -1)).toBe(true);
    expect(wheel.current(1141, -1)).toBe(false);
  });

  it("settles replaced, completed and disposed navigation promises", async () => {
    let release!: () => void;
    const navigation = new ReaderNavigation(() => {});
    const active = navigation.submit(() => new Promise<void>((resolve) => { release = resolve; }));
    const replaced = navigation.submit(async () => {});
    const latest = navigation.submit(async () => {}, true);
    expect(await replaced).toBe(false);
    release();
    expect(await active).toBe(false);
    expect(await latest).toBe(true);
    navigation.dispose();
    expect(await navigation.submit(async () => {})).toBe(false);
  });
});

describe("EPUB progress boundaries", () => {
  const location = {
    start: { cfi: "start", displayed: { page: 3, total: 4 } },
    end: { displayed: { page: 4, total: 4 } },
  };
  it("shows 100% at the end even before indexing completes", () => {
    expect(epubProgress({ ...location, atEnd: true }).whole).toBe(1);
    expect(epubProgress({ ...location, atEnd: true }, 0.949).whole).toBe(1);
  });
  it("uses explicit book boundaries rather than a chapter's last page", () => {
    expect(epubProgress(location, 0.75)).toEqual({ chapter: 1, whole: 0.75 });
    expect(epubProgress(location, 1).whole).toBeLessThan(1);
    expect(epubProgress({ ...location, atStart: true }, 0.2).whole).toBe(0);
  });
});

describe("fractional pagination", () => {
  it("reaches the final column despite fractional scroll offsets", () => {
    expect(pageScrollTarget(2534.6667, 5068, 1267, 1267, 1)).toBe(3801);
    expect(pageScrollTarget(3801, 5068, 1267, 1267, 1)).toBeUndefined();
    expect(pageScrollTarget(0.667, 5068, 1267, 1267, -1)).toBeUndefined();
    expect(pageScrollTarget(1267.667, 5068, 1267, 1267, -1)).toBeCloseTo(0.667);
  });
});

describe("ZIP resource paths", () => {
  it("resolves package-relative and percent-encoded paths without a renderer origin", () => {
    expect(archivePath("../images/cover%20one.jpeg", "/OEBPS/text/chapter.xhtml")).toBe("/OEBPS/images/cover one.jpeg");
    expect(archivePath("images/cover.jpeg", "/titlepage.xhtml")).toBe("/images/cover.jpeg");
    expect(archivePath("https://example.com/image.jpeg", "/chapter.xhtml")).toBeUndefined();
    expect(archivePath("//example.com/image.jpeg", "/chapter.xhtml")).toBeUndefined();
    expect(archivePath("file:///C:/secret", "/chapter.xhtml")).toBeUndefined();
  });
});
