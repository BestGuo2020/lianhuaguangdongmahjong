import { expect, type Page } from '@playwright/test'

export const LONG_QUICK_CHAT = '我有一百种办法胡你，而你却无可奈何'

export async function sendLongQuickChat(page: Page) {
  await page.getByRole('button', { name: '快捷语', exact: true }).click({ timeout: 45_000 })
  const dialog = page.getByRole('dialog', { name: '快捷语', exact: true })
  await dialog.getByRole('button', { name: '气氛', exact: true }).click()
  await dialog.getByRole('button', { name: LONG_QUICK_CHAT, exact: true }).click()
  await expect(dialog).toBeHidden()
}

export async function expectTableInteractionEcho(host: Page, guest: Page) {
  await Promise.all([host, guest].map(page => expect(
    page.getByRole('button', { name: '快捷语', exact: true }),
  ).toBeVisible({ timeout: 45_000 })))
  const hostSeat = await host.locator('.user-identity').getAttribute('data-table-seat')
  const guestSeat = await guest.locator('.user-identity').getAttribute('data-table-seat')
  expect(hostSeat).toMatch(/^[0-3]$/)
  expect(guestSeat).toMatch(/^[0-3]$/)
  expect(hostSeat).not.toBe(guestSeat)

  await sendLongQuickChat(host)
  await Promise.all([host, guest].map(page => expect(
    page.locator(`[data-quick-chat-seat="${hostSeat}"]`),
  ).toHaveText(LONG_QUICK_CHAT)))

  await guest.locator(`.player-seat[data-table-seat="${hostSeat}"] .avatar-button`).click()
  await guest.getByRole('dialog', { name: /使用互动道具/ }).getByRole('button', { name: '点赞', exact: true }).click()
  await Promise.all([host, guest].map(page => expect(page.locator(
    `.emote-performance[data-emote="like"][data-from-seat="${guestSeat}"][data-target-seat="${hostSeat}"]`,
  )).toHaveCount(1)))
}
