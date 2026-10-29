import {act,cleanup,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {RequestAge} from "./RequestAge";
afterEach(()=>{cleanup();vi.useRealTimers();});
it("keeps minute precision through 59 to 60 minutes using the same shared clock and legacy default",()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-28T15:59:00Z"));
 render(<><RequestAge createdAt="2026-10-28T15:00:00Z" precision="minutes"/><RequestAge createdAt="2026-10-28T15:00:00Z"/></>);
 expect(screen.getAllByText("59 мин назад")).toHaveLength(2);expect(vi.getTimerCount()).toBe(1);
 act(()=>vi.advanceTimersByTime(60000));
 expect(screen.getByText("1 ч 0 мин назад")).toHaveAttribute("datetime","2026-10-28T15:00:00.000Z");
 expect(screen.getByText("1 ч назад")).toBeVisible();expect(vi.getTimerCount()).toBe(1);
 cleanup();expect(vi.getTimerCount()).toBe(0);
});
it("shows 1h12 and live minute ticks while preserving default hour-only output",()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-28T16:12:00Z"));
 render(<><RequestAge createdAt="2026-10-28T15:00:00Z" precision="minutes"/><RequestAge createdAt="2026-10-28T15:00:00Z"/></>);
 expect(screen.getByText("1 ч 12 мин назад")).toBeVisible();expect(screen.getByText("1 ч назад")).toBeVisible();
 act(()=>vi.advanceTimersByTime(60000));expect(screen.getByText("1 ч 13 мин назад")).toBeVisible();
});
it("includes days, remaining hours and minutes only when opted in",()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-29T16:12:00Z"));
 render(<><RequestAge createdAt="2026-10-28T15:00:00Z" precision="minutes"/><RequestAge createdAt="2026-10-28T15:00:00Z"/></>);
 expect(screen.getByText("1 дн 1 ч 12 мин назад")).toBeVisible();expect(screen.getByText("1 дн назад")).toBeVisible();
});
