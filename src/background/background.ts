// https://stackoverflow.com/questions/49996456/importing-json-file-in-typescript
import manifest from "../../public/manifest.json";

import {devMode, disabledIcon, enabledIcon} from "../shared/constants";
import messageType from "../messages/messageType";
import Tab = chrome.tabs.Tab;
import OnUpdatedInfo = chrome.tabs.OnUpdatedInfo;

console.info(manifest.name + " " + manifest.version + " background.js started");

type TabData = { enabled: boolean };

function normalizeHostname(url:string) {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "");
}

// On click
chrome.action.onClicked.addListener(async (tab:Tab) => {

    if (tab.id && tab.url) {

        const storageKey:string = normalizeHostname(tab.url); // << hostname
        const tabData:{[key:string]:TabData} = await chrome.storage.local.get(storageKey);

        // The ?? operator in TypeScript is the nullish coalescing operator.
        // It is used to provide a default value only when the left-hand side operand is explicitly null or undefined
        const enabled:boolean = tabData[storageKey]?.enabled ?? false;
        const newState:boolean = !enabled;

        // send a message to the content script
        const message:messageType = {action: "toggle", enabled: newState};

        try {
            const response = await chrome.tabs.sendMessage(tab.id, message);

            if (devMode){
                console.log("sendMessage response:", response);
            }

            if (!response?.ok) throw new Error("No valid response");

        } catch (error) {
            if (devMode){
                console.log("sendMessage failed:", error);
            }

            // Content script not yet injected — inject it programmatically
            //  "scripting" permission is needed in manifest.json.
            await chrome.scripting.insertCSS({
                target: { tabId: tab.id },
                files: ["content.css"],
            });
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["content.js"],
            });
            // Retry now that the script is present
            await chrome.tabs.sendMessage(tab.id, message);
        }

        // store the new state
        tabData[storageKey] = {enabled: newState};
        await chrome.storage.local.set(tabData);

        // Visual feedback: swap icon or badge
        await chrome.action.setIcon({
            tabId: tab.id,
            path: newState ? enabledIcon : disabledIcon
        });

    } else {
        if(devMode){
            console.error("No tab.id or tab.url found");
        }
        return;
    }
});


// Tab navigation — re-applies state when the user navigates within a domain
chrome.tabs.onUpdated.addListener(async (tabId: number, changeInfo: OnUpdatedInfo, tab:Tab) => {
    // Only act when the page has finished loading
    if (changeInfo.status !== "complete" || !tab.url) return;

    const storageKey:string = normalizeHostname(tab.url); // << hostname
    const tabData:{[key:string]:TabData} = await chrome.storage.local.get(storageKey);

    // The ?? operator in TypeScript is the nullish coalescing operator.
    // It is used to provide a default value only when the left-hand side operand is explicitly null or undefined
    const enabled:boolean = tabData[storageKey]?.enabled ?? false;


    if (enabled) {
        await chrome.tabs.sendMessage(tabId, {action: "toggle", enabled: true});
    }

    await chrome.action.setIcon({
        tabId: tab.id,
        path: enabled ? enabledIcon : disabledIcon
    });

});