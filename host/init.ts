import * as path from "path";
import { promisify } from "util";

import { readJSON, packageRelative, writeFile, exists, unlink } from "./fileUtils";

export default async function init(basePath: string) {
	const packagePath = path.resolve(basePath, "package.json");
	const newPackageFile = !await exists(packagePath);
	try {
		if (newPackageFile) {
			const mobiusPackageData = await readJSON(packageRelative("package.json"));
			const defaultPackageFile = {
				"dependencies": {
					[mobiusPackageData.name]: "^" + mobiusPackageData.version,
				},
				"scripts": {
					"start": "mobius"
				},
				"main": "app.tsx"
			};
			await writeFile(packagePath, JSON.stringify(defaultPackageFile, null, 2) + "\n");
		}
		const result = await promisify(require("init-package-json"))(basePath, path.resolve(process.env.HOME, ".npm-init"));
		const mainPath = path.resolve(basePath, result.main);
		if (!await exists(mainPath)) {
			await writeFile(mainPath, `import * as dom from "dom";\n\ndom.host(<div>Hello World!</div>);\n`);
		}
		const gitIgnorePath = path.resolve(basePath, ".gitignore");
		if (!await exists(gitIgnorePath)) {
			await writeFile(gitIgnorePath, `.cache\n.sessions\n`);
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

