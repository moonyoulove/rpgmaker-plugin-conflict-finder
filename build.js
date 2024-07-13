import AdmZip from "adm-zip";
import { program } from "commander";
import fs from "node:fs";
import pathlib from "node:path";
import ora from "ora";
import shell from "shelljs";

program
    .requiredOption("--start-js <path>", "javascript file to bundle")
    .requiredOption("--app-name <name>", "executable app name")
    .option("--build-dir <dir>", "build folder", "./build")
    .option("--node-path <path>", "custom node binary path to copy")
    .option("--compress [extra-path...]", "compress app and extra file into zip", null)
    .parse();
const options = program.opts();
const { startJs, buildDir, appName, nodePath } = options;
const needsCompress = !!options.compress;
const extraFilePaths = options.compress || [];
const platform = { win32: "windows", darwin: "macos" }[process.platform] ?? "linux";
const bundledName = `bundled-${basename(startJs)}`;
const spinner = ora();

spinner.text = "Bundle javascript file";
await exec(
    `node ./bundle.js --entry=${startJs} --outfile=${buildDir}/${bundledName}.cjs`,
);

spinner.text = "Create configuration file";
const config = {
    main: `${buildDir}/${bundledName}.cjs`,
    output: `${buildDir}/sea-prep.blob`,
    disableExperimentalSEAWarning: true,
};
await write(`${buildDir}/sea-config.json`, JSON.stringify(config));

spinner.text = "Generating sea-prep.blob";
await exec(`node --experimental-sea-config ${buildDir}/sea-config.json`);

spinner.text = "Copying node binary";
await copy(
    nodePath ?? process.execPath,
    `${buildDir}/${appName}${platform === "windows" ? ".exe" : ""}`,
);

spinner.text = "Removing signature";
if (platform === "windows" && shell.which("signtool")) {
    await exec(`signtool remove /s ${buildDir}/${appName}.exe`);
} else if (platform === "macos") {
    await exec(`codesign --remove-signature ${buildDir}/${appName}`);
}

spinner.text = "Injecting sea-prep.blob";
if (platform === "windows") {
    await exec(
        `postject ${buildDir}/${appName}.exe NODE_SEA_BLOB ./build/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite`,
    );
} else if (platform === "macos") {
    // It seems that node.js installed by .pkg cannot be used
    await exec(
        `postject ${buildDir}/${appName} NODE_SEA_BLOB ./build/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA --overwrite`,
    );
} else {
    await exec(
        `postject ${buildDir}/${appName} NODE_SEA_BLOB ./build/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite`,
    );
}

spinner.text = "Signing binary";
if (platform === "macos") {
    await exec(`codesign --sign - ${buildDir}/${appName}`);
}

if (needsCompress) {
    spinner.text = "Compressing application";
    await compress();
}

spinner.succeed("All done!");

async function exec(command) {
    spinner.start();
    const [code, stdout, stderr] = await new Promise(resolve => {
        shell.exec(command, { silent: true, async: true }, (...args) => resolve(args));
    });
    if (code !== 0) {
        spinner.fail();
        throw new Error(stderr || stdout);
    } else {
        spinner.succeed();
        return stdout;
    }
}

async function copy(src, dest) {
    spinner.start();
    const error = await new Promise(resolve => {
        fs.copyFile(src, dest, resolve);
    });
    if (error) {
        spinner.fail();
        throw error;
    } else {
        spinner.succeed();
    }
}

async function write(file, data) {
    spinner.start();
    const error = await new Promise(resolve => {
        fs.writeFile(file, data, resolve);
    });
    if (error) {
        spinner.fail();
        throw error;
    } else {
        spinner.succeed();
    }
}

async function compress() {
    spinner.start();
    try {
        const zip = new AdmZip();
        zip.addLocalFile(`${buildDir}/${appName}${platform === "windows" ? ".exe" : ""}`);
        for (const path of extraFilePaths) {
            zip.addLocalFile(path);
        }
        const version = process.env.npm_package_version;
        const packageName = process.env.npm_package_name;
        await zip.writeZipPromise(`${buildDir}/${packageName}-${version}-${platform}.zip`)
            .catch(error => {
                throw error;
            });
        spinner.succeed();
    } catch (error) {
        spinner.fail();
        throw error;
    }
}

function basename(path) {
    return pathlib.basename(path, pathlib.extname(path));
}
