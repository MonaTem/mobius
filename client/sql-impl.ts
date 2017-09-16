import { createServerPromise } from "mobius";
import { ExecuteResult } from "sql";
import { Redacted } from "redact";

export const execute = createServerPromise as (host: string | Redacted<string>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>) => Promise<ExecuteResult>;
