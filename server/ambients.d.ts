import { Request } from "express";

declare global {
	export const self: NodeJS.Global & {
		document: Document,
	};
}
