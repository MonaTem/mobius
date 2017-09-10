import includePaths from "rollup-plugin-includepaths";

export default {
	entry: "src/app.js",
	dest: "public/client.js",
	format: "iife",
	plugins: [
		includePaths({
			include: {
				"preact": "preact/dist/preact.esm.js"
			},
			paths: ["src", "common", "client", "preact/dist"]
		})
	]
};
