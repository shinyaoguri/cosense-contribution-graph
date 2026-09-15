import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../../src/shared/graph.ts";
import { layoutGraph } from "../../src/shared/graph-layout.ts";
import { buildScale } from "../../src/shared/scale.ts";
import { renderGraphElement } from "../../src/userscript/render.ts";

function layout(today = "2026-09-09", days = new Map([["2026-09-08", { w: 10, r: 20 }]])) {
  return layoutGraph({
    today,
    days,
    scale: buildScale([...days.values()].map((d) => d.w + d.r)),
    center: 0,
    params: DEFAULT_PARAMS,
  });
}

function render(options: { today?: string; scale?: number } = {}) {
  const graph = layout(options.today);
  const svg = renderGraphElement(document, graph, {
    label: "合算の草",
    tooltip: (day) => `tip ${day}`,
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
  });
  const groups = [...svg.children];
  return { graph, svg, labels: groups[0], grid: groups[1], legend: groups[2] };
}

describe("renderGraphElement", () => {
  it("**レイアウトの寸法で SVG を作り、名前空間は SVG**", () => {
    const { graph, svg } = render();

    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("width")).toBe(String(graph.width));
    expect(svg.getAttribute("height")).toBe(String(graph.height));
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${graph.width} ${graph.height}`);
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("合算の草");
  });

  it("**倍率は width と height だけを変え、viewBox はそのまま**", () => {
    const { graph, svg } = render({ scale: 0.5 });

    expect(svg.getAttribute("width")).toBe(String(graph.width * 0.5));
    expect(svg.getAttribute("height")).toBe(String(graph.height * 0.5));
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${graph.width} ${graph.height}`);
  });

  it.each([
    ["水曜", "2026-09-09"],
    ["日曜", "2026-09-13"],
    ["土曜", "2026-09-12"],
  ])(
    "**格子はレイアウトのマスと同じ位置と色 (%s)。** 53 週で 365 マス、マスごとにツールチップ",
    (_, today) => {
      const { graph, grid } = render({ today });

      const rects = [...(grid?.children ?? [])];
      expect(rects).toHaveLength(365);
      expect(graph.grid).toHaveLength(365);
      rects.forEach((node, i) => {
        const cell = graph.grid[i];
        expect(node.tagName).toBe("rect");
        expect(node.getAttribute("x")).toBe(String(cell?.x));
        expect(node.getAttribute("y")).toBe(String(cell?.y));
        expect(node.getAttribute("fill")).toBe(cell?.fill);
        expect(node.getAttribute("width")).toBe(String(graph.cellSize));
        expect(node.getAttribute("rx")).toBe(String(graph.cellRadius));
        expect(node.querySelector("title")?.textContent).toBe(`tip ${cell?.day}`);
      });
    },
  );

  it("ラベルは textContent で入れ、`end` のときだけ text-anchor を付ける。凡例のマスにツールチップは無い", () => {
    const { graph, labels, legend } = render();

    const texts = [...(labels?.children ?? [])];
    expect(texts.map((t) => t.textContent)).toEqual(graph.labels.map((l) => l.text));
    texts.forEach((node, i) => {
      const anchor = graph.labels[i]?.anchor;
      expect(node.getAttribute("text-anchor")).toBe(anchor === "end" ? "end" : null);
    });
    expect(labels?.getAttribute("fill")).toBe(graph.textColor);
    expect(legend?.children).toHaveLength(graph.legend.length);
    expect(legend?.querySelector("title")).toBeNull();
  });

  it("**属性のハンドラを使わない** (Cosense の CSP は script-src-attr 'none')", () => {
    const { svg } = render();

    const handlers = [svg, ...svg.querySelectorAll("*")].flatMap((node) =>
      [...node.attributes].filter((attr) => attr.name.startsWith("on")),
    );
    expect(handlers).toEqual([]);
  });

  it("母集団が空でも描ける", () => {
    const graph = layoutGraph({
      today: "2026-09-09",
      days: new Map(),
      scale: buildScale([]),
      center: 0,
      params: DEFAULT_PARAMS,
    });

    const svg = renderGraphElement(document, graph, { label: "空", tooltip: () => "記録なし" });

    expect(svg.querySelectorAll("rect")).toHaveLength(365 + graph.legend.length);
  });
});
