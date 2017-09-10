import { createServerPromise } from "mobius";
import { ExecuteResult } from "sql";

export const execute = createServerPromise as (host: string, sql: string, params?: any[]) => Promise<ExecuteResult>;
