import { expect, test } from "@playwright/test";

for (const [viewport, size] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test.describe(viewport, () => {
    test.use({ viewport: size });
    for (const [app, port] of [
      ["compiler", 4273],
      ["manual", 4274],
      ["baseline", 4275],
      ["compiler-profile", 4173],
      ["manual-profile", 4174],
      ["baseline-profile", 4175],
    ] as const) {
      test(`${app}: notifications, settings, operations and favorites`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${port}`);
        await expect(page.locator("tbody tr")).toHaveCount(200);
        const notificationButton = page.getByRole("button", { name: "Open notifications" });
        await expect(page.getByTestId("notifications")).toHaveText("3");
        await notificationButton.click();
        const inbox = page.getByRole("dialog", { name: "Notifications", exact: true });
        await expect(inbox).toBeVisible();
        await expect(inbox).toHaveCSS("border-radius", "12px");
        const dialogBounds = await inbox.boundingBox();
        expect(dialogBounds).not.toBeNull();
        expect(dialogBounds!.width).toBeLessThanOrEqual(Math.min(560, size.width - 32));
        expect(dialogBounds!.x).toBeGreaterThanOrEqual(0);
        await expect(inbox.locator(".workspace-dialog-heading")).toHaveCSS("display", "flex");
        await expect(
          inbox.getByRole("button", { name: "Close Notifications", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(inbox.getByRole("button", { name: "Mark all as read" })).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(
          inbox.getByRole("button", { name: "Close Notifications", exact: true }),
        ).toBeFocused();
        expect(await inbox.evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
        await expect(page.getByTestId("notifications")).toHaveText("3");
        await inbox.getByRole("button", { name: "Mark INC-0001 as read", exact: true }).click();
        await expect(page.getByTestId("notifications")).toHaveText("2");
        await page.keyboard.press("Escape");
        await expect(inbox).toHaveCount(0);
        await expect(notificationButton).toBeFocused();
        await notificationButton.click();
        await expect(inbox.getByText("Read · INC-0001", { exact: true })).toBeVisible();
        await inbox.getByRole("button", { name: "Mark all as read" }).click();
        await expect(page.getByTestId("notifications")).toHaveText("0");
        await expect(inbox.getByRole("button", { name: "Mark all as read" })).toBeDisabled();
        await inbox.getByRole("button", { name: "Close Notifications", exact: true }).click();

        const profileButton = page.getByRole("button", { name: "Profile settings for Alex Chen" });
        await profileButton.click();
        const settings = page.getByRole("dialog", { name: "Profile settings", exact: true });
        const name = settings.getByRole("textbox", { name: "Display name" });
        await name.fill("Sam Rivera");
        await settings.getByRole("radio", { name: "Compact", exact: true }).check();
        await settings.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(profileButton).toBeFocused();
        await expect(page.locator(".app")).toHaveAttribute("data-density", "comfortable");
        await profileButton.click();
        await expect(name).toHaveValue("Alex Chen");
        await name.fill("   ");
        await settings.getByRole("button", { name: "Save settings" }).click();
        await expect(settings).toBeVisible();
        expect(await name.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
        await name.fill("  Sam Rivera  ");
        await settings.getByRole("radio", { name: "Compact", exact: true }).check();
        await page.screenshot({ path: `benchmark/results/settings-${app}-${viewport}.png` });
        await settings.getByRole("button", { name: "Save settings" }).click();
        await expect(
          page.getByRole("button", { name: "Profile settings for Sam Rivera" }),
        ).toHaveText("SR");
        await expect(page.locator(".app")).toHaveAttribute("data-density", "compact");
        await expect(page.locator("tbody tr").first()).toHaveCSS("height", "44px");

        const favorites = page.getByRole("button", { name: "Favorites only", exact: true });
        await favorites.click();
        await expect(page.locator("tbody tr")).toHaveCount(0);
        await expect(page.getByText("No incidents match your filters.")).toBeVisible();
        await favorites.click();
        await page.getByRole("button", { name: "Favorite INC-0001", exact: true }).click();
        await page.getByRole("button", { name: "Favorite INC-0002", exact: true }).click();
        await favorites.click();
        await expect(page.locator("tbody .incident-id")).toHaveText(["INC-0001", "INC-0002"]);
        await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("oldest");
        await expect(page.locator("tbody .incident-id")).toHaveText(["INC-0002", "INC-0001"]);
        await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("Open");
        await expect(page.locator("tbody .incident-id")).toHaveText(["INC-0001"]);
        await page.getByRole("textbox", { name: "Search incidents" }).fill("INC-0002");
        await expect(page.locator("tbody tr")).toHaveCount(0);
        await page.getByRole("textbox", { name: "Search incidents" }).fill("");
        await page.getByRole("button", { name: "Unfavorite INC-0001", exact: true }).click();
        await expect(page.locator("tbody tr")).toHaveCount(0);

        const operationsButton = page.getByRole("button", { name: "Open operations desk" });
        await operationsButton.click();
        const operations = page.getByRole("dialog", { name: "Operations desk", exact: true });
        await expect(
          operations.getByText("134 active incidents across three queues"),
        ).toBeVisible();
        await expect(operations.getByText("No active incidents", { exact: true })).toBeVisible();
        await page.screenshot({ path: `benchmark/results/operations-${app}-${viewport}.png` });
        await page.keyboard.press("Escape");
        await expect(operationsButton).toBeFocused();
        await operationsButton.click();
        await operations.getByRole("button", { name: "View Payments queue" }).click();
        await expect(operations).toHaveCount(0);
        await expect(favorites).toHaveAttribute("aria-pressed", "false");
        await expect(page.getByRole("combobox", { name: "Status", exact: true })).toHaveValue(
          "All statuses",
        );
        await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue(
          "newest",
        );
        await expect(page.getByTestId("total")).toHaveText("67");
        await favorites.click();
        await expect(page.locator("tbody .incident-id")).toHaveText(["INC-0002"]);

        await notificationButton.click();
        await inbox.getByRole("button", { name: "View INC-0001", exact: true }).click();
        await expect(inbox).toHaveCount(0);
        await expect(favorites).toHaveAttribute("aria-pressed", "false");
        await expect(page.getByTestId("total")).toHaveText("200");
        const detail = page.getByRole("dialog", { name: "Incident detail", exact: true });
        await expect(detail).toContainText("INC-0001");
        if (viewport === "mobile") {
          await expect(detail.getByRole("button", { name: "Close detail" })).toBeFocused();
        }
        await detail.getByRole("button", { name: "Mark resolved" }).click();
        await detail.getByRole("button", { name: "Close detail" }).click();
        await operationsButton.click();
        await expect(
          operations.getByText("133 active incidents across three queues"),
        ).toBeVisible();
        await operations
          .getByRole("button", { name: "Close Operations desk", exact: true })
          .click();
        await notificationButton.click();
        await expect(
          inbox
            .locator("li")
            .filter({ hasText: "INC-0001" })
            .getByText("Resolved", { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: `benchmark/results/workspace-${app}-${viewport}.png` });
        await page.reload();
        await expect(page.getByTestId("notifications")).toHaveText("3");
        await expect(profileButton).toHaveText("AC");
        await expect(page.locator(".app")).toHaveAttribute("data-density", "comfortable");
        await expect(
          page.getByRole("button", { name: "Favorite INC-0002", exact: true }),
        ).toHaveAttribute("aria-pressed", "false");
        await expect(page.getByTestId("total")).toHaveText("200");
        await expect(favorites).toHaveAttribute("aria-pressed", "false");
        expect(errors).toEqual([]);
      });
    }
  });
}
