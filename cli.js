#!/usr/bin/env node
import blessed from "blessed";
import { program } from "commander";
import { osLocaleSync } from "os-locale";
import { ConflictOutput } from "./lib/blessed.js";
import { findConflict } from "./lib/conflict.js";
import "dotenv/config";

program
    .name("conflict-finder")
    .option("--project <path>", "rpg maker mv/mz project path")
    .option("--no-unicode", "disable full unicode support for CJK to avoid lag when data is large")
    .option("--theme <color>", "theme color support color name or hex (default: \"cyan\")")
    .option("--editor <name>", "text editor to open conflict plugins")
    .parse();
const options = program.opts();
const themeColor = options.theme || process.env.COLOR || "cyan";
const { screen, prompt, loading } = createBlessed();
start();

async function start() {
    const projectPath = options.project || await askProjectPath();
    if (projectPath) {
        const conflicts = await findConflictPromise(projectPath);
        const output = new ConflictOutput(conflicts, projectPath, options.unicode, themeColor, options.editor);
        output.show();
    } else {
        process.exit(0);
    }
}

function createBlessed() {
    const screen = blessed.screen({
        smartCSR: true,
        fullUnicode: true,
        title: "conflict-finder",
    });
    const prompt = blessed.textbox({
        width: "60%",
        height: "shrink",
        border: {
            type: "line",
        },
        top: "center",
        left: "center",
        keys: true,
        label: "Project path",
        focusEffects: {
            border: {
                fg: themeColor,
            },
        },
        hidden: true,
    });
    screen.append(prompt);
    const loading = blessed.text({
        hidden: true,
        width: "shrink",
        height: "shrink",
        top: "center",
        left: "center",
        border: {
            type: "line",
        },
        content: "Finding conflicts...",
        focusEffects: {
            border: {
                fg: themeColor,
            },
        },
    });
    screen.append(loading);
    return { screen, prompt, loading };
}

function askProjectPath() {
    return new Promise(resolve => {
        prompt.show();
        screen.saveFocus();
        prompt.focus();
        prompt.content = "dummy word";
        screen.render();
        prompt.content = placeHolderText();
        screen.render();
        prompt.readInput((err, value) => {
            prompt.hide();
            screen.restoreFocus();
            resolve(value);
        });
    });
}

function placeHolderText() {
    const locale = osLocaleSync();
    const texts = {};
    texts["zh-TW"] = `輸入專案路徑，然後按Enter...`;

    texts["zh-CN"] = `输入项目路径，然后按 Enter...`;

    texts["en"] = `Input project path, then press Enter...`;
    return texts[locale] || texts[locale.split("-")[0]] || texts["en"];
}

async function findConflictPromise(projectPath) {
    screen.saveFocus();
    loading.show();
    loading.focus();
    return new Promise(resolve => {
        setTimeout(() => {
            const conflicts = findConflict(projectPath);
            loading.hide();
            screen.restoreFocus();
            resolve(conflicts);
        }, 10);
    });
}
