import { test, expect, type Locator } from "@playwright/test";

/**
 * Asserts that the tooltip is positioned near the anchor element,
 * i.e. not stuck at the top-left corner of the page.
 *
 * Checks:
 *  - Vertical: the tooltip's edge is within `maxVerticalGap` px of the anchor's edge.
 *  - Horizontal: the centre-to-centre distance is within `maxHorizontalGap` px.
 */
async function expectTooltipNear(
  tooltip: Locator,
  anchor: Locator,
  { maxVerticalGap = 150, maxHorizontalGap = 300 } = {},
) {
  const tooltipBox = await tooltip.boundingBox();
  const anchorBox = await anchor.boundingBox();
  expect(tooltipBox, "tooltip bounding box should exist").not.toBeNull();
  expect(anchorBox, "anchor bounding box should exist").not.toBeNull();

  // Vertical: either the tooltip sits above or below the anchor
  const gapAbove = Math.abs(
    (tooltipBox!.y + tooltipBox!.height) - anchorBox!.y,
  );
  const gapBelow = Math.abs(
    tooltipBox!.y - (anchorBox!.y + anchorBox!.height),
  );
  expect(
    gapAbove < maxVerticalGap || gapBelow < maxVerticalGap,
    `tooltip should be near the anchor vertically (gapAbove=${gapAbove.toFixed(0)}, gapBelow=${gapBelow.toFixed(0)})`,
  ).toBe(true);

  // Horizontal: centres should be reasonably close
  const tooltipCenterX = tooltipBox!.x + tooltipBox!.width / 2;
  const anchorCenterX = anchorBox!.x + anchorBox!.width / 2;
  expect(
    Math.abs(tooltipCenterX - anchorCenterX),
    "tooltip should be near the anchor horizontally",
  ).toBeLessThan(maxHorizontalGap);
}

test.describe("Lean Markdown Renderer E2E Tests", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for the loading spinner to disappear (up to 30 seconds)
    await page.locator("#content[aria-busy='true']").waitFor({ state: "detached", timeout: 30000 });
  });

  test("should load the page and render semantic highlights", async ({ page }) => {
    await expect(page).toHaveTitle(/(Lean Markdown Renderer|Example Chapter · Basic Example)/);

    // Check that there is at least one lean code block
    const codeBlocks = page.locator("pre code.language-lean");
    await expect(codeBlocks.first()).toBeVisible();
    await expect(await codeBlocks.count()).toBeGreaterThan(0);

    // Verify key syntax highlighted classes are populated
    const keywords = page.locator(".lean-keyword");
    await expect(keywords.first()).toBeVisible();
    const firstKeywordText = await keywords.first().innerText();
    expect(firstKeywordText).toMatch(/^(def|instance|theorem|by|constructor|simp|grind|where|mem)$/);

    const variables = page.locator(".lean-variable");
    await expect(variables.first()).toBeVisible();
  });

  test("should highlight comments in green without swallowing code", async ({ page }) => {
    const comments = page.locator(".lean-comment");
    await expect(comments.first()).toBeVisible();

    const commentTexts = await comments.allInnerTexts();
    expect(commentTexts).toContain("-- A line comment");
    expect(commentTexts).toContain("/-- A doc comment for `answer`. -/");
    expect(commentTexts).toContain("-- trailing comment");
    // A block comment is emitted per line, so each line stands on its own.
    expect(commentTexts).toContain("/- A block");
    expect(commentTexts).toContain("comment -/");
    // Comment markers inside a string literal are code, not comments.
    expect(commentTexts.some((t) => t.includes("not a comment"))).toBe(false);

    const color = await comments.first().evaluate((el) => getComputedStyle(el).color);
    const [r, g, b] = color.match(/\d+/g)!.map(Number) as [number, number, number];
    expect(g, `comment color ${color} should be green-dominant`).toBeGreaterThan(r);
    expect(g, `comment color ${color} should be green-dominant`).toBeGreaterThan(b);
  });

  test("should synchronize hovers for identifiers with the same data-symbol", async ({ page }) => {
    const symbols = page.locator("[data-symbol]");
    await expect(symbols.first()).toBeVisible();

    const firstSymbol = symbols.first();
    const symbolId = await firstSymbol.getAttribute("data-symbol");
    expect(symbolId).toBeTruthy();

    const siblingSymbols = page.locator(`[data-symbol="${symbolId}"]`);
    const siblingCount = await siblingSymbols.count();

    // No highlights initially
    await expect(page.locator(".lean-hovered")).toHaveCount(0);

    // Hover highlights all matching symbols
    await firstSymbol.hover();
    for (let i = 0; i < siblingCount; i++) {
      await expect(siblingSymbols.nth(i)).toHaveClass(/lean-hovered/);
    }

    // Moving away removes highlights
    await page.locator("h1").hover();
    for (let i = 0; i < siblingCount; i++) {
      await expect(siblingSymbols.nth(i)).not.toHaveClass(/lean-hovered/);
    }
  });

  test("should show tooltip on hover and support nested/stacked tooltips with mouse transition", async ({ page }) => {
    const hoverable = page.locator("[data-hover-id]").first();
    await expect(hoverable).toBeVisible();

    await hoverable.hover();

    const tooltip = page.locator(".lean-tooltip").first();
    await expect(tooltip).toBeVisible();

    // Tooltip should appear near the hovered element, not at the page origin
    await expectTooltipNear(tooltip, hoverable);

    // Check that tooltip has some content
    const tooltipText = await tooltip.innerText();
    expect(tooltipText.length).toBeGreaterThan(0);

    // Nested tooltips: hover over an identifier inside the tooltip
    const subHoverable = tooltip.locator("[data-hover-id]");
    if (await subHoverable.count() > 0) {
      await subHoverable.first().hover();

      const allTooltips = page.locator(".lean-tooltip");
      await expect(allTooltips).toHaveCount(2);

      // Hover over the nested child tooltip itself (moving mouse out of parent tooltip trigger/bounds)
      await allTooltips.nth(1).hover();
      await page.waitForTimeout(300); // Wait for potential hide timers to fire

      // Both tooltips must remain visible
      await expect(allTooltips.nth(0)).toBeVisible();
      await expect(allTooltips.nth(1)).toBeVisible();
    }

    // Moving away closes all tooltips
    await page.locator("h1").hover();
    await page.waitForTimeout(400);
    await expect(page.locator(".lean-tooltip")).toHaveCount(0);
  });

  test("should display goal state when hovering over proof state markers (…)", async ({ page }) => {
    const goalMarkers = page.locator("span.lean-goal-marker");
    await expect(goalMarkers.first()).toBeVisible();

    const firstGoal = goalMarkers.first();
    await firstGoal.hover();

    const tooltip = page.locator(".lean-tooltip").first();
    await expect(tooltip).toBeVisible();

    // Tooltip should appear near the goal marker, not at the page origin
    await expectTooltipNear(tooltip, firstGoal);

    const tooltipText = await tooltip.innerText();
    expect(tooltipText).toMatch(/(⊢|no goals|S : Type)/);

    // Moving away closes the tooltip
    await page.locator("h1").hover();
    await page.waitForTimeout(400);
    await expect(page.locator(".lean-tooltip")).toHaveCount(0);
  });

  test("should open external permalinks in a new tab when clicking on external symbols", async ({ page, context }) => {
    // Check if there's any element with data-permalink
    const externalLink = page.locator("[data-permalink]");
    await expect(externalLink.first()).toBeVisible();

    const permalinkUrl = await externalLink.first().getAttribute("data-permalink");
    expect(permalinkUrl).toContain("https://github.com/leanprover/lean4/blob/");

    // Wait for the popup/new tab when clicking the link
    const [newPage] = await Promise.all([
      context.waitForEvent("page"),
      externalLink.first().click(),
    ]);

    expect(newPage.url()).toBe(permalinkUrl!);
    await newPage.close();
  });

  test("should scroll to local definition when clicking on a usage of a local symbol", async ({ page }) => {
    // Find all local definition elements
    const defElements = page.locator('[data-is-definition="true"]');
    const defCount = await defElements.count();
    expect(defCount).toBeGreaterThan(0);

    let foundSymbolId = "";
    let usageLocator = null;
    let defLocator = null;

    // Find a definition that has at least one usage on the page
    for (let i = 0; i < defCount; i++) {
      const defEl = defElements.nth(i);
      const symbolId = await defEl.getAttribute("data-symbol");
      if (symbolId) {
        const usageEl = page.locator(`[data-symbol="${symbolId}"]:not([data-is-definition="true"])`);
        if (await usageEl.count() > 0) {
          foundSymbolId = symbolId;
          usageLocator = usageEl.first();
          defLocator = defEl;
          break;
        }
      }
    }

    expect(foundSymbolId).toBeTruthy();
    expect(usageLocator).not.toBeNull();
    expect(defLocator).not.toBeNull();

    // Trigger scroll by clicking the usage element
    await usageLocator!.click();

    // The definition element should get the flash class
    await expect(defLocator!).toHaveClass(/lean-flash/);
  });

  test("should scroll to local definition across different code blocks on the same page", async ({ page }) => {
    // Find the definition of Set in the second block (index 1)
    const setDef = page.locator('pre code.language-lean').nth(1).locator('span:text-is("Set")').first();
    await expect(setDef).toHaveAttribute("data-is-definition", "true");

    // Find the usage of Set in the fourth block (index 3)
    const setUsage = page.locator('pre code.language-lean').nth(3).locator('span:text-is("Set")').first();
    await expect(setUsage).not.toHaveAttribute("data-is-definition");

    const usageSymbol = await setUsage.getAttribute("data-symbol");
    expect(usageSymbol).toBeTruthy();

    // Click the usage
    await setUsage.click();
    await page.waitForTimeout(500); // Give it a moment to run the click listener

    // The definition should get flashed
    await expect(setDef).toHaveClass(/lean-flash/);
  });

  test("should render and hydrate nested lean code blocks inside blockquotes", async ({ page }) => {
    // Find a code block inside a blockquote
    const nestedCodeBlock = page.locator("blockquote pre code.language-lean");
    await expect(nestedCodeBlock).toBeVisible();

    // Verify it is highlighted
    const keywords = nestedCodeBlock.locator(".lean-keyword");
    await expect(keywords.first()).toBeVisible();
    await expect(await keywords.first().innerText()).toMatch(/^(def|instance|theorem|by|constructor|simp|grind|where|mem)$/);

    const variables = nestedCodeBlock.locator(".lean-variable");
    await expect(variables.first()).toBeVisible();

    // Verify hovers inside the nested block work
    const hoverable = nestedCodeBlock.locator("[data-hover-id]").first();
    await expect(hoverable).toBeVisible();
    await hoverable.hover();

    const tooltip = page.locator(".lean-tooltip").first();
    await expect(tooltip).toBeVisible();
    await expectTooltipNear(tooltip, hoverable);
  });

  test("should not format or highlight non-lean code blocks", async ({ page }) => {
    // Find the JavaScript code block
    const jsCodeBlock = page.locator("pre code.language-javascript");
    await expect(jsCodeBlock).toBeVisible();

    // Verify it doesn't have any Lean-specific classes or attributes
    const leanKeywords = jsCodeBlock.locator(".lean-keyword");
    const leanVariables = jsCodeBlock.locator(".lean-variable");
    const leanHoverables = jsCodeBlock.locator("[data-hover-id]");
    
    await expect(leanKeywords).toHaveCount(0);
    await expect(leanVariables).toHaveCount(0);
    await expect(leanHoverables).toHaveCount(0);
  });

  test("should respect hover debounce and cancel pending tooltip if mouse leaves early", async ({ page }) => {
    const hoverable = page.locator("[data-hover-id]").first();
    await expect(hoverable).toBeVisible();

    // 1. Move mouse to hoverable but leave quickly (before 500ms debounce threshold)
    await hoverable.hover();
    await page.waitForTimeout(150);
    
    // Move away to h1
    await page.locator("h1").hover();
    
    // Wait for the rest of the 500ms window + some padding (e.g. 500ms total from move away)
    await page.waitForTimeout(500);

    // Verify no tooltip is created/visible
    const tooltipsCount = await page.locator(".lean-tooltip").count();
    expect(tooltipsCount).toBe(0);

    // 2. Move mouse back and wait long enough (e.g. 700ms)
    await hoverable.hover();
    await page.waitForTimeout(700);

    // Verify tooltip is now visible
    const tooltip = page.locator(".lean-tooltip").first();
    await expect(tooltip).toBeVisible();
  });

  test("should keep hover highlight when moving between elements of the same symbol", async ({ page }) => {
    // Find a symbol with multiple occurrences
    const symbols = page.locator("[data-symbol]");
    await expect(symbols.first()).toBeVisible();

    const count = await symbols.count();
    let targetSymbol = "";
    let occurrence1 = null;
    let occurrence2 = null;

    for (let i = 0; i < count; i++) {
      const symbol = symbols.nth(i);
      const symbolId = await symbol.getAttribute("data-symbol");
      if (symbolId) {
        const matches = page.locator(`[data-symbol="${symbolId}"]`);
        if (await matches.count() > 1) {
          targetSymbol = symbolId;
          occurrence1 = matches.nth(0);
          occurrence2 = matches.nth(1);
          break;
        }
      }
    }

    expect(targetSymbol).toBeTruthy();

    // Hover over first occurrence
    await occurrence1!.hover();
    await expect(occurrence1!).toHaveClass(/lean-hovered/);
    await expect(occurrence2!).toHaveClass(/lean-hovered/);

    // Move directly to the second occurrence
    await occurrence2!.hover();

    // Both should remain highlighted
    await expect(occurrence1!).toHaveClass(/lean-hovered/);
    await expect(occurrence2!).toHaveClass(/lean-hovered/);
  });

  test("should handle nested tooltip state transitions correctly", async ({ page }) => {
    // 1. Open the first tooltip (hover over 'hello')
    const hoverable = page.locator("[data-hover-id]").first();
    await expect(hoverable).toBeVisible();
    await hoverable.hover();

    const parentTooltip = page.locator(".lean-tooltip").first();
    await expect(parentTooltip).toBeVisible();

    // 2. Find a sub-hoverable inside the parent tooltip
    const subHoverable = parentTooltip.locator("[data-hover-id]").first();
    await expect(subHoverable).toBeVisible();
    await subHoverable.hover();

    // 3. Verify nested tooltip is shown
    const allTooltips = page.locator(".lean-tooltip");
    await expect(allTooltips).toHaveCount(2);
    const childTooltip = allTooltips.nth(1);
    await expect(childTooltip).toBeVisible();

    // 4. Hover over the child tooltip itself
    await childTooltip.hover();
    await page.waitForTimeout(300);

    // Verify both are still visible
    await expect(parentTooltip).toBeVisible();
    await expect(childTooltip).toBeVisible();

    // 5. Move mouse back to the parent tooltip (but not on any hoverable element inside it)
    await parentTooltip.hover();

    // Wait for the child tooltip hide timeout (250ms) to fire
    await page.waitForTimeout(350);

    // Verify child tooltip is now closed, but parent tooltip remains open
    await expect(parentTooltip).toBeVisible();
    await expect(childTooltip).not.toBeVisible();
    await expect(allTooltips).toHaveCount(1);

    // 6. Move mouse completely away (to h1)
    await page.locator("h1").hover();
    await page.waitForTimeout(350);

    // Verify all tooltips are closed
    await expect(page.locator(".lean-tooltip")).toHaveCount(0);
  });

  test("should display diagnostic info when hovering over inline diagnostics or summaries", async ({ page }) => {
    const diagnosticMarkers = page.locator(".lean-diagnostic-inline, .lean-diagnostic-summary");
    await expect(diagnosticMarkers.first()).toBeVisible();
    await expect(await diagnosticMarkers.count()).toBeGreaterThan(0);

    const firstDiag = diagnosticMarkers.first();
    await firstDiag.hover();

    const tooltip = page.locator(".lean-tooltip").first();
    await expect(tooltip).toBeVisible();

    const tooltipText = await tooltip.innerText();
    expect(tooltipText).toMatch(/(2|Nat.add : Nat → Nat → Nat|"Hello" : String)/);

    // Moving away closes the tooltip
    await page.locator("h1").hover();
    await page.waitForTimeout(400);
    await expect(page.locator(".lean-tooltip")).toHaveCount(0);
  });

  test("should keep ellipsis and inline markers (span.lean-goal-marker, .lean-diagnostic-inline, .lean-diagnostic-details) separate and not nested inside other syntax spans", async ({ page }) => {
    const goalMarkers = page.locator("span.lean-goal-marker");
    const countGoals = await goalMarkers.count();
    for (let i = 0; i < countGoals; i++) {
      const parent = goalMarkers.nth(i).locator("xpath=..");
      const parentClass = await parent.getAttribute("class") || "";
      const hasTokenClass = parentClass.split(/\s+/).some(cls => cls.startsWith("lean-") && cls !== "lean-goal-marker" && !cls.startsWith("lean-diagnostic-"));
      expect(hasTokenClass).toBe(false);
    }

    const diagMarkers = page.locator(".lean-diagnostic-inline, .lean-diagnostic-details");
    const countDiags = await diagMarkers.count();
    for (let i = 0; i < countDiags; i++) {
      const parent = diagMarkers.nth(i).locator("xpath=..");
      const parentClass = await parent.getAttribute("class") || "";
      const hasTokenClass = parentClass.split(/\s+/).some(cls => cls.startsWith("lean-") && cls !== "lean-goal-marker" && !cls.startsWith("lean-diagnostic-"));
      expect(hasTokenClass).toBe(false);
    }
  });

  test("should render squiggly underlines for errors/warnings without ellipsis/inline diagnostic markers, and show combined tooltips", async ({ page }) => {
    // Verify squiggly error and warning elements are visible
    const errorSquigglies = page.locator(".lean-squiggly-error");
    const warningSquigglies = page.locator(".lean-squiggly-warning");

    await expect(errorSquigglies.first()).toBeVisible();
    await expect(warningSquigglies.first()).toBeVisible();

    // Verify there are no diagnostic markers on the same lines
    // "hello" error and "x" warning should not be accompanied by inline diagnostics or summaries at the end of the line
    // We can verify that the diagnostic markers only exist for "#eval" and "#check" lines
    const diagnosticMarkers = page.locator(".lean-diagnostic-inline, .lean-diagnostic-summary");
    const count = await diagnosticMarkers.count();
    for (let i = 0; i < count; i++) {
      const hoverId = await diagnosticMarkers.nth(i).getAttribute("data-hover-id") || "";
      const registryText = await page.locator(".lean-hover-data").first().textContent();
      const registry = JSON.parse(registryText || "{}");
      const text = registry.hovers[hoverId] || "";
      // The marker tooltip should not contain "type mismatch" or "unused"
      expect(text).not.toContain("type mismatch");
      expect(text).not.toContain("unused");
    }

    // Hover over the error squiggly ("hello") and check tooltip content
    const errorEl = errorSquigglies.first();
    await errorEl.hover();
    
    let tooltip = page.locator(".lean-tooltip").first();
    await expect(tooltip).toBeVisible();
    let tooltipHtml = await tooltip.innerHTML();
    expect(tooltipHtml).toContain("failed to synthesize instance");

    // Move away
    await page.locator("h1").hover();
    await page.waitForTimeout(300);
    await expect(page.locator(".lean-tooltip")).toHaveCount(0);

    // Hover over the warning squiggly ("x")
    const warningEl = warningSquigglies.first();
    await warningEl.hover();

    tooltip = page.locator(".lean-tooltip").first();
    await expect(tooltip).toBeVisible();
    tooltipHtml = await tooltip.innerHTML();

    // It should contain the warning text
    expect(tooltipHtml).toContain("unused");
  });
});
