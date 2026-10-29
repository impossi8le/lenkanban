import type { PrismaClient, MyDayEntry as StoredEntry } from "@prisma/client";
import { BadRequestError, ConflictError } from "./errors";
import { isDayKey, MY_DAY_MAX_LENGTH, todayMoscow, type MyDayEntry } from "./my-day-contract";

export class MyDayConflict extends ConflictError {
  constructor(readonly current: MyDayEntry) {
    super("Дневник изменён в другом окне. Выберите, какой текст сохранить.");
  }
}

export function createMyDayService(database: Pick<PrismaClient, "myDayEntry">, clock = () => new Date()) {
  function validate(date: string) {
    if (!isDayKey(date) || date > todayMoscow(clock())) throw new BadRequestError("Выберите сегодняшнюю или прошедшую дату.");
  }
  function dto(date: string, row: StoredEntry | null): MyDayEntry {
    return { date, text: row?.text ?? "", version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null, today: todayMoscow(clock()) };
  }
  const where = (ownerId: string, date: string) => ({ ownerId_date: { ownerId, date: new Date(`${date}T00:00:00.000Z`) } });
  async function read(ownerId: string, date: string): Promise<MyDayEntry> {
    validate(date);
    return dto(date, await database.myDayEntry.findUnique({ where: where(ownerId, date) }));
  }
  async function save(ownerId: string, date: string, input: { text: string; expectedVersion: number; operationId: string }): Promise<MyDayEntry> {
    validate(date);
    if (typeof input.text !== "string" || input.text.length > MY_DAY_MAX_LENGTH || input.text.includes("\0")
      || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= 2_147_483_647
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)) {
      throw new BadRequestError("Проверьте текст и повторите сохранение.");
    }
    const operationId = input.operationId.toLowerCase();
    const key = where(ownerId, date);
    const data = { text: input.text, lastOperationId: operationId };
    // One unique insert or version-conditional update is the sole writer.
    if (input.expectedVersion === 0) {
      try {
        const row = await database.myDayEntry.create({ data: { ...data, ownerId, date: key.ownerId_date.date } });
        return dto(date, row);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
      }
    } else {
      try {
        // Prisma emits the version predicate and RETURNING in one statement.
        const row = await database.myDayEntry.update({
          where: { ...key, version: input.expectedVersion, NOT: { lastOperationId: operationId } },
          data: { ...data, version: { increment: 1 } },
        });
        return dto(date, row);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "P2025")) throw error;
      }
    }
    const current = await database.myDayEntry.findUnique({ where: key });
    if (current?.lastOperationId === operationId && current.text === input.text && current.version === input.expectedVersion + 1) {
      return dto(date, current);
    }
    throw new MyDayConflict(dto(date, current));
  }
  return { read, save };
}
