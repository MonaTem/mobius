import { Request } from "express";
import { ConcurrenceJsonMap } from "concurrence-types";

declare global {
	export const self: NodeJS.Global & {
		document: Document,
		request: Request,
	};
}
