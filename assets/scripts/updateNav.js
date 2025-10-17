#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const DOCS_DIR = path.join(ROOT_DIR, "docs");
const MKDOCS_PATH = path.join(ROOT_DIR, "mkdocs.yml");
const ARGS = process.argv.slice(2);

const OPTIONS = parseArgs(ARGS);

function parseArgs(args) {
    const result = {
        numbered: false,
    };

    args.forEach((arg) => {
        if (arg === "--numbered" || arg === "-n") {
            result.numbered = true;
        } else if (arg === "--no-numbered") {
            result.numbered = false;
        } else if (arg.startsWith("--numbered=")) {
            const value = arg.split("=")[1];
            if (value === "true" || value === "1") {
                result.numbered = true;
            } else if (value === "false" || value === "0") {
                result.numbered = false;
            }
        }
    });

    return result;
}

function getMarkdownFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return getMarkdownFiles(fullPath);
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
            return [fullPath];
        }
        return [];
    });
}

function extractMetadata(filePath) {
    const content = fs.readFileSync(filePath, "utf8");
    let title = null;
    let order = null;
    if (content.startsWith("---")) {
        const end = content.indexOf("\n---", 3);
        if (end !== -1) {
            const frontMatter = content.slice(3, end).split(/\r?\n/);
            for (const line of frontMatter) {
                const match = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.+)$/);
                if (match) {
                    const key = match[1].trim();
                    const value = cleanValue(match[2]);
                    if (key === "title" && value !== "") {
                        title = value;
                    }
                    if (key === "nav_order") {
                        const numeric = Number(value);
                        if (!Number.isNaN(numeric)) {
                            order = numeric;
                        }
                    }
                }
            }
        }
    }
    if (!title) {
        const headingMatch = content.match(/^#\s+(.+)/m);
        if (headingMatch) {
            title = headingMatch[1].trim();
        }
    }
    if (!title) {
        title = path.basename(filePath, ".md");
    }
    return { title, order };
}

function cleanValue(raw) {
    let value = raw.trim();
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1).trim();
    }
    return value;
}

function buildNavEntries(files) {
    return files
        .map((filePath) => {
            const { title, order } = extractMetadata(filePath);
            const relativePath = path.relative(DOCS_DIR, filePath).replace(/\\/g, "/");
            return { title, relativePath, order };
        })
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function createNode(name) {
    return {
        name,
        dirs: new Map(),
        dirOrder: [],
        files: [],
        label: null,
        order: null,
    };
}

function buildNavTree(entries) {
    const root = createNode("root");

    entries.forEach(({ title, relativePath, order }) => {
        const segments = relativePath.split("/");
        let current = root;
        for (let i = 0; i < segments.length; i += 1) {
            const segment = segments[i];
            const isFile = i === segments.length - 1;
            if (isFile) {
                const fileEntry = { title, relativePath, order };
                const basename = path.basename(segment, path.extname(segment)).toLowerCase();
                if (basename === "index") {
                    current.label = title;
                    if (order !== null && order !== undefined) {
                        current.order = order;
                    }
                    fileEntry.order = 0;
                    current.files.push(fileEntry);
                } else {
                    current.files.push(fileEntry);
                }
            } else {
                if (!current.dirs.has(segment)) {
                    current.dirs.set(segment, createNode(segment));
                    current.dirOrder.push(segment);
                }
                current = current.dirs.get(segment);
            }
        }
    });

    sortTree(root);
    return root;
}

function sortTree(node) {
    node.dirOrder.sort((a, b) => {
        const aNode = node.dirs.get(a);
        const bNode = node.dirs.get(b);
        const orderDiff = compareOrderValues(aNode.order, bNode.order);
        if (orderDiff !== 0) {
            return orderDiff;
        }
        return getNodeLabel(aNode).localeCompare(getNodeLabel(bNode));
    });
    node.dirOrder.forEach((dirName) => {
        sortTree(node.dirs.get(dirName));
    });
    node.files.sort((a, b) => {
        const orderDiff = compareOrderValues(a.order, b.order);
        if (orderDiff !== 0) {
            return orderDiff;
        }
        return a.title.localeCompare(b.title);
    });
}

function getNodeLabel(node) {
    return node.label || node.name;
}

function compareOrderValues(a, b) {
    const normalizedA = a === null || a === undefined ? Number.POSITIVE_INFINITY : a;
    const normalizedB = b === null || b === undefined ? Number.POSITIVE_INFINITY : b;
    if (normalizedA === normalizedB) {
        return 0;
    }
    return normalizedA < normalizedB ? -1 : 1;
}

function formatYamlString(value) {
    if (value === "" || /[\n\r]/.test(value)) {
        return JSON.stringify(value);
    }
    const safePattern = /^[\w\-\.\s\/!()\u0080-\uFFFF]+$/;
    if (
        safePattern.test(value) &&
        !value.startsWith(" ") &&
        !value.endsWith(" ") &&
        !/[#:]/.test(value)
    ) {
        return value;
    }
    return JSON.stringify(value);
}

function treeToNavLines(tree) {
    const lines = ["nav:"];
    appendNodeLines(tree, 4, lines, [], OPTIONS);
    return lines;
}

function appendNodeLines(node, indentLevel, lines, numberingPath, options) {
    const indent = " ".repeat(indentLevel);
    const entries = [];

    node.dirOrder.forEach((dirName) => {
        const child = node.dirs.get(dirName);
        entries.push({
            type: "dir",
            label: getNodeLabel(child),
            order: child.order,
            node: child,
        });
    });

    node.files.forEach((fileEntry) => {
        entries.push({
            type: "file",
            label: fileEntry.title,
            order: fileEntry.order,
            file: fileEntry,
        });
    });

    entries.sort((a, b) => {
        const orderDiff = compareOrderValues(a.order, b.order);
        if (orderDiff !== 0) {
            return orderDiff;
        }
        if (a.label && b.label) {
            const labelCompare = a.label.localeCompare(b.label);
            if (labelCompare !== 0) {
                return labelCompare;
            }
        }
        const pathA = a.type === "file" ? a.file.relativePath : a.node.name;
        const pathB = b.type === "file" ? b.file.relativePath : b.node.name;
        return pathA.localeCompare(pathB);
    });

    entries.forEach((entry, index) => {
        const nextNumber = numberingPath.length === 0 ? index + 1 : index;
        const currentPath = options.numbered ? numberingPath.concat(nextNumber) : numberingPath;
        let label = entry.label;
        if (options.numbered) {
            label = `${formatNumberPrefix(currentPath)}${entry.label}`;
        }

        if (entry.type === "dir") {
            lines.push(`${indent}- ${formatYamlString(label)}:`);
            const nextPath = options.numbered ? currentPath : numberingPath;
            appendNodeLines(entry.node, indentLevel + 4, lines, nextPath, options);
        } else {
            lines.push(
                `${indent}- ${formatYamlString(label)}: ${formatYamlString(entry.file.relativePath)}`
            );
        }
    });
}

function formatNumberPrefix(path) {
    if (path.length === 0) {
        return "";
    }
    if (path.length === 1) {
        return `${path[0]}. `;
    }
    return `${path[0]}-${path.slice(1).join("-")}. `;
}

function updateMkdocs(navLines) {
    if (!fs.existsSync(MKDOCS_PATH)) {
        throw new Error(`mkdocs.yml not found at ${MKDOCS_PATH}`);
    }
    const content = fs.readFileSync(MKDOCS_PATH, "utf8");
    const lines = content.split(/\r?\n/);
    const navIndex = lines.findIndex((line) => line.trim() === "nav:");

    if (navIndex === -1) {
        throw new Error("nav section not found in mkdocs.yml");
    }

    let endIndex = navIndex + 1;
    while (endIndex < lines.length) {
        const line = lines[endIndex];
        if (line.trim() === "") {
            endIndex += 1;
            continue;
        }
        if (/^[ \t]/.test(line)) {
            endIndex += 1;
            continue;
        }
        break;
    }

    const updatedLines = [...lines.slice(0, navIndex), ...navLines, ...lines.slice(endIndex)];
    fs.writeFileSync(MKDOCS_PATH, `${updatedLines.join("\n")}\n`);
}

function main() {
    if (!fs.existsSync(DOCS_DIR)) {
        throw new Error(`docs directory not found at ${DOCS_DIR}`);
    }
    const files = getMarkdownFiles(DOCS_DIR);
    if (files.length === 0) {
        console.warn("No markdown files found. nav section not updated.");
        return;
    }

    const navEntries = buildNavEntries(files);
    const tree = buildNavTree(navEntries);
    const navLines = treeToNavLines(tree);
    updateMkdocs(navLines);
    console.log("mkdocs.yml nav updated successfully.");
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
