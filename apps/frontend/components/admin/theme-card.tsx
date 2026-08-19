"use client";

import * as React from "react";
import { Palette, RotateCcw } from "lucide-react";

import {
  ApiError,
  type AdminSettings,
  type AdminSettingsUpdate,
} from "@/lib/api";
import { formatOklch, oklchToHex, parseColor } from "@/lib/color";
import {
  buildSiteThemeCss,
  MAX_SITE_RADIUS,
  MIN_SITE_RADIUS,
  SITE_THEME_GROUPS,
  SITE_THEME_TOKENS,
  type SiteThemeBase,
} from "@/lib/site-theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * The site theme editor — the third theme in the switcher, next to light and
 * dark. See `docs/theming.md`.
 *
 * Two things shape this form:
 *
 *   - **Every colour is optional.** The stored theme is a base plus overrides,
 *     so a blank field means "follow the base palette" rather than "black". The
 *     inherited value is read out of the browser with `getComputedStyle` on a
 *     probe element carrying the base class, which keeps this form from holding
 *     a second copy of the palette that could drift from `globals.css`.
 *   - **The preview uses the real builder.** `buildSiteThemeCss` scoped to the
 *     preview's id produces the same declarations the root layout will emit, so
 *     there is no separate preview implementation to disagree with production.
 */
export function ThemeCard({
  settings,
  patch,
}: {
  settings: AdminSettings;
  patch: (update: AdminSettingsUpdate) => Promise<AdminSettings>;
}) {
  const [base, setBase] = React.useState<SiteThemeBase>(settings.theme.base);
  const [values, setValues] = React.useState<Record<string, string>>(
    settings.theme.colors,
  );
  const [radius, setRadius] = React.useState(
    settings.theme.radius === null ? "" : String(settings.theme.radius),
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // What each token resolves to when it is not overridden, measured rather than
  // duplicated. Re-read whenever the base changes.
  const probe = React.useRef<HTMLSpanElement>(null);
  const [inherited, setInherited] = React.useState<Record<string, string>>({});

  React.useLayoutEffect(() => {
    if (!probe.current) return;
    const computed = getComputedStyle(probe.current);
    const next: Record<string, string> = {};
    for (const token of SITE_THEME_TOKENS) {
      const raw = computed.getPropertyValue(`--${token.key}`).trim();
      const resolved = resolveCssColor(raw);
      next[token.key] = resolved ? formatOklch(resolved) : raw;
    }
    setInherited(next);
  }, [base]);

  const overrides = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value.trim()) out[key] = value.trim();
    }
    return out;
  }, [values]);

  const invalid = React.useMemo(
    () => Object.keys(overrides).filter((key) => !parseColor(overrides[key]!)),
    [overrides],
  );

  const radiusNumber = radius.trim() === "" ? null : Number(radius);
  const radiusInvalid =
    radiusNumber !== null &&
    (!Number.isFinite(radiusNumber) ||
      radiusNumber < MIN_SITE_RADIUS ||
      radiusNumber > MAX_SITE_RADIUS);

  // Only well-formed values reach the preview, so a half-typed hex does not
  // make the whole panel flicker while the operator is still typing.
  const previewCss = buildSiteThemeCss(
    {
      base,
      colors: Object.fromEntries(
        Object.entries(overrides).flatMap(([key, value]) => {
          const parsed = parseColor(value);
          return parsed ? [[key, formatOklch(parsed)] as const] : [];
        }),
      ),
      radius: radiusInvalid ? null : radiusNumber,
    },
    "#site-theme-preview",
  );

  const setToken = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      await patch({
        theme: {
          base,
          colors: overrides,
          radius: radiusInvalid ? null : radiusNumber,
        },
      });
      // The palette is baked into a server-rendered <style>, so only a reload
      // repaints the panel the admin is currently looking at.
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the theme.");
      setLoading(false);
    }
  };

  const dirty =
    base !== settings.theme.base ||
    radiusNumber !== settings.theme.radius ||
    JSON.stringify(overrides) !== JSON.stringify(settings.theme.colors);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="size-4" />
          Site theme
        </CardTitle>
        <CardDescription>
          The third option in every user&apos;s theme menu, and the default for
          anyone who has not chosen one. Light and dark are fixed; this is the
          palette that carries your brand.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Off-screen, but laid out: getComputedStyle needs it in the render
            tree to resolve the custom properties the base class sets. */}
        <span
          ref={probe}
          aria-hidden
          className={cn(
            "pointer-events-none fixed size-0 overflow-hidden",
            base === "dark" && "dark",
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="theme-base">Base palette</FieldLabel>
            <Select
              value={base}
              onValueChange={(v) => setBase(v as SiteThemeBase)}
            >
              <SelectTrigger id="theme-base" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              What every colour you leave blank falls back to, and whether the
              panel treats the site theme as a dark surface.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="theme-radius">Corner radius</FieldLabel>
            <Input
              id="theme-radius"
              type="number"
              inputMode="decimal"
              step={0.125}
              min={MIN_SITE_RADIUS}
              max={MAX_SITE_RADIUS}
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              placeholder="0.625"
              aria-invalid={radiusInvalid || undefined}
            />
            <FieldDescription>
              In <code>rem</code>, {MIN_SITE_RADIUS}–{MAX_SITE_RADIUS}. Blank
              keeps the shipped 0.625.
            </FieldDescription>
          </Field>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Colours</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setValues({})}
              disabled={Object.keys(overrides).length === 0}
            >
              <RotateCcw className="size-4" />
              Clear all overrides
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Blank follows the base palette. Type a hex value or an{" "}
            <code>oklch()</code> triple, or use the swatch — everything is stored
            as <code>oklch</code>, which is what the rest of the design tokens
            use.
          </p>

          {SITE_THEME_GROUPS.map((group) => (
            <div key={group} className="flex flex-col gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group}
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                {SITE_THEME_TOKENS.filter((token) => token.group === group).map(
                  (token) => (
                    <TokenRow
                      key={token.key}
                      label={token.label}
                      hint={token.hint}
                      tokenKey={token.key}
                      value={values[token.key] ?? ""}
                      inherited={inherited[token.key] ?? ""}
                      onChange={(next) => setToken(token.key, next)}
                    />
                  ),
                )}
              </div>
            </div>
          ))}
        </div>

        <ThemePreview css={previewCss} base={base} />

        {invalid.length > 0 && (
          <p className="text-sm text-destructive">
            Not a colour the panel can use: {invalid.join(", ")}.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div>
          <Button
            onClick={save}
            disabled={loading || !dirty || invalid.length > 0 || radiusInvalid}
          >
            {loading && <Spinner />}
            Save site theme
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Turn whatever the browser reports a token as into OKLCh.
 *
 * `getComputedStyle` does not hand back the `oklch()` that `globals.css` was
 * written in: Lightning CSS downlevels those to `lab()` at build time for older
 * browser targets, so the inherited values arrive in a syntax `parseColor`
 * deliberately refuses. Rather than teach the parser every colour space a build
 * step might emit, hand the string to the one component that already knows all
 * of them — a canvas context — and take the sRGB it resolves to.
 *
 * The answer is read back as pixels rather than from `fillStyle`, because the
 * getter round-trips a wide-gamut colour in its own space — ask it about a
 * `lab()` and it says `lab()` again. Painting one pixel forces the conversion
 * into the canvas's sRGB backing store, which is the same gamut
 * `<input type="color">` is limited to anyway.
 *
 * Validity still comes from `fillStyle`, which silently keeps its previous
 * value when handed something it cannot parse. Two different sentinels are what
 * makes that detectable: an accepted colour reads back the same from either
 * starting point, a rejected one reads back as whichever sentinel was set.
 *
 * This is for display only. A colour the operator *stores* still goes through
 * `parseColor`, which is the boundary that keeps the stylesheet numeric.
 */
let canvasContext: CanvasRenderingContext2D | null | undefined;

function resolveCssColor(value: string) {
  if (!value) return null;
  const direct = parseColor(value);
  if (direct) return direct;

  if (canvasContext === undefined) {
    canvasContext = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true });
  }
  const ctx = canvasContext;
  if (!ctx) return null;

  ctx.fillStyle = "#000000";
  ctx.fillStyle = value;
  const fromBlack = ctx.fillStyle;
  ctx.fillStyle = "#ffffff";
  ctx.fillStyle = value;
  if (ctx.fillStyle !== fromBlack) return null;

  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (r === undefined || g === undefined || b === undefined) return null;

  const hex = [r, g, b, a ?? 255]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("");
  return parseColor(`#${hex}`);
}

function TokenRow({
  label,
  hint,
  tokenKey,
  value,
  inherited,
  onChange,
}: {
  label: string;
  hint: string;
  tokenKey: string;
  value: string;
  inherited: string;
  onChange: (value: string) => void;
}) {
  const effective = value.trim() || inherited;
  const parsed = parseColor(effective);
  const overridden = value.trim().length > 0;
  const broken = overridden && !parsed;
  const id = `theme-color-${tokenKey}`;

  return (
    <div className="flex items-center gap-2 rounded-md border p-2">
      <label
        className="relative size-8 shrink-0 overflow-hidden rounded-md border"
        // The checkerboard shows through a translucent token such as the dark
        // border, which is otherwise indistinguishable from the card behind it.
        style={{
          backgroundImage:
            "linear-gradient(45deg,var(--muted) 25%,transparent 25%,transparent 75%,var(--muted) 75%),linear-gradient(45deg,var(--muted) 25%,transparent 25%,transparent 75%,var(--muted) 75%)",
          backgroundSize: "8px 8px",
          backgroundPosition: "0 0,4px 4px",
        }}
      >
        <span
          aria-hidden
          className="absolute inset-0"
          style={parsed ? { background: effective } : undefined}
        />
        <input
          type="color"
          aria-label={`${label} colour`}
          value={parsed ? oklchToHex(parsed) : "#000000"}
          onChange={(e) => {
            const picked = parseColor(e.target.value);
            if (picked) onChange(formatOklch(picked));
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={id} className="flex items-center gap-1.5 text-sm">
          <span className="truncate font-medium">{label}</span>
          {overridden && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              set
            </Badge>
          )}
        </label>
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={inherited || "inherited"}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={broken || undefined}
          aria-describedby={`${id}-hint`}
          className="h-7 font-mono text-xs"
        />
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={`Reset ${label}`}
        onClick={() => onChange("")}
        disabled={!overridden}
      >
        <RotateCcw className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * A live sample of the theme, built from the real components so the preview
 * inherits every token the panel actually uses rather than a hand-drawn
 * approximation. The `dark` class is what makes `dark:` utilities inside behave
 * the way they will under a dark-based site theme.
 */
function ThemePreview({ css, base }: { css: string; base: SiteThemeBase }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Preview</p>
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <div
        id="site-theme-preview"
        className={cn(
          "overflow-hidden rounded-lg border bg-background text-foreground",
          base === "dark" && "dark",
        )}
      >
        <div className="flex items-center justify-between border-b bg-card px-3 py-2">
          <span className="text-sm font-semibold">Servers</span>
          <span className="text-xs text-muted-foreground">3 online</span>
        </div>
        <div className="flex flex-col gap-3 p-3">
          <div className="rounded-md border bg-card p-3 text-card-foreground">
            <p className="text-sm font-medium">survival.example.com</p>
            <p className="text-xs text-muted-foreground">
              Running · 4 GB · eu-west
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Start</Button>
            <Button size="sm" variant="secondary">
              Restart
            </Button>
            <Button size="sm" variant="destructive">
              Kill
            </Button>
            <Badge variant="secondary">SFTP</Badge>
          </div>
          <Input placeholder="Search servers" className="h-8" readOnly />
        </div>
      </div>
    </div>
  );
}
