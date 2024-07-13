import { program } from "commander";
import * as esbuild from "esbuild";
import fs from "node:fs";
import pathlib from "node:path";

program
    .requiredOption("--entry <path>")
    .requiredOption("--outfile <path>")
    .parse();
const options = program.opts();
const blessedWidgetResolve = {
    name: "blessedWidgetResolve",
    setup(build) {
        build.onLoad({ filter: /node_modules[\\\/]blessed[\\\/]lib[\\\/]widget\.js$/ }, (args) => {
            const contents = fs.readFileSync(args.path, "utf-8").replace(/require\('\.\/widgets\/' \+ file/, "$& + \".js\"");
            return { contents };
        });

        build.onLoad({ filter: /node_modules[\\\/]blessed[\\\/]lib[\\\/]tput\.js$/ }, (args) => {
            const contents = fs.readFileSync(args.path, "utf-8");

            var infoPath = pathlib.resolve("node_modules", "blessed", "usr", "xterm-256color"),
                capPath = pathlib.resolve("node_modules", "blessed", "usr", "xterm.termcap");

            var infoPathFake = pathlib.resolve(
                pathlib.sep,
                "usr",
                "share",
                "terminfo",
                pathlib.basename(infoPath)[0],
                pathlib.basename(infoPath),
            );

            function readMethods() {
                Tput._infoBuffer = new Buffer.from(TERMINFO, "base64");

                Tput.prototype.readTerminfo = function() {
                    this.terminal = TERMINFO_NAME;
                    return this.parseTerminfo(Tput._infoBuffer, TERMINFO_PATH);
                };

                Tput.cpaths = [];
                Tput.termcap = TERMCAP;

                Tput.prototype._readTermcap = Tput.prototype.readTermcap;
                Tput.prototype.readTermcap = function() {
                    this.terminal = TERMCAP_NAME;
                    return this._readTermcap(this.terminal);
                };

                Tput.prototype.detectUnicode = function() {
                    return true;
                };
            }

            readMethods = readMethods.toString().slice(24, -2)
                .replace(/^  /gm, "")
                .replace("TERMINFO", JSON.stringify(fs.readFileSync(infoPath, "base64")))
                .replace("TERMINFO_NAME", JSON.stringify(pathlib.basename(infoPath)))
                .replace("TERMINFO_PATH", JSON.stringify(infoPathFake))
                .replace("TERMCAP", JSON.stringify(fs.readFileSync(capPath, "utf8")))
                .replace("TERMCAP_NAME", JSON.stringify(pathlib.basename(capPath, ".termcap")));

            return {
                contents: contents + "\n" + readMethods,
            };
        });
    },
};
await esbuild.build({
    entryPoints: [options.entry],
    bundle: true,
    outfile: options.outfile,
    plugins: [blessedWidgetResolve],
    external: ["term.js", "pty.js"],
    platform: "node",
});
