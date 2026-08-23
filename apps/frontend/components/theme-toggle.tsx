"use client";

import { Moon, Palette, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { useBranding } from "@/components/branding-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The three-way theme switcher: the operator's site theme, light, and dark.
 *
 * The trigger icon is chosen by the `theme-*` CSS variants rather than by
 * `useTheme()`. next-themes resolves the stored preference in a blocking script
 * before first paint but only publishes it to React after hydration, so reading
 * it here would either flash the wrong icon or need a `mounted` guard that
 * renders nothing at all. Letting the class on `<html>` pick the icon is correct
 * from the first frame, and the palette fallback matches the default theme for
 * the server-rendered markup that has no class yet.
 *
 * The menu contents may use `useTheme()` freely, since a closed menu renders
 * nothing, so by the time there is a checkmark to draw the client is hydrated.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { siteName } = useBranding();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label="Change theme" />}
      >
        <Sun className="hidden size-4 theme-light:block" />
        <Moon className="hidden size-4 theme-dark:block" />
        <Palette className="size-4 theme-light:hidden theme-dark:hidden" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="site">
            <Palette className="size-4 text-muted-foreground" />
            <span className="truncate">{siteName}</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4 text-muted-foreground" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4 text-muted-foreground" />
            Dark
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
