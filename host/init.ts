import * as path from "path";
import { promisify } from "util";

import { exists, mkdir, packageRelative, readJSON, unlink, writeFile } from "./fileUtils";

export default async function init(basePath: string) {
	const packagePath = path.resolve(basePath, "package.json");
	const newPackageFile = !await exists(packagePath);
	try {
		if (newPackageFile) {
			const mobiusPackageData = await readJSON(packageRelative("package.json"));
			const defaultPackageFile = {
				dependencies: {
					[mobiusPackageData.name]: "^" + mobiusPackageData.version,
				},
				scripts: {
					start: "mobius --launch",
				},
				main: "app.tsx",
			};
			await writeFile(packagePath, JSON.stringify(defaultPackageFile, null, 2) + "\n");
		}
		const result = await promisify(require("init-package-json"))(basePath, path.resolve(process.env.HOME || "~", ".npm-init"));
		const mainPath = path.resolve(basePath, result.main);
		if (!await exists(mainPath)) {
			await writeFile(mainPath, `import * as dom from "dom";\n//import { query } from "sql";\n//import { send, receive } from "broadcast";\n\ndom.host(<div>Hello World!</div>);\ndom.style("style.css");\n`);
		}
		const gitIgnorePath = path.resolve(basePath, ".gitignore");
		if (!await exists(gitIgnorePath)) {
			await writeFile(gitIgnorePath, `node_modules\n.cache\n.sessions\n`);
		}
		const publicPath = path.resolve(basePath, "public");
		if (!await exists(publicPath)) {
			await mkdir(publicPath);
		}
		const stylePath = path.resolve(publicPath, "style.css");
		if (!await exists(stylePath)) {
			await writeFile(stylePath, `/* Insert styles here */\n`);
		}
	} catch (e) {
		if (e instanceof Error && e.message === "canceled") {
			if (newPackageFile) {
				await unlink(packagePath);
			}
		}
		throw e;
	}
}

if (require.main === module) {
	init(process.cwd());
}
