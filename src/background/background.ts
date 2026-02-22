import {disabledIcon, enabledIcon} from "../constants";
import messageType from "../messages/messageType";

console.log("background.js started");

type TabData = { enabled: boolean };

function normalizeHostname(url:string) {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "");
}

chrome.action.onClicked.addListener(async (tab) => {

    if (tab.id && tab.url) {

        const storageKey:string = normalizeHostname(tab.url); // << hostname

        const tabData:{[key:string]:TabData} = await chrome.storage.local.get(storageKey);

        // The ?? operator in TypeScript is the nullish coalescing operator.
        // It is used to provide a default value only when the left-hand side operand is explicitly null or undefined
        const enabled:boolean = tabData[storageKey]?.enabled ?? false;
        const newState:boolean = !enabled;

        // send a message to the content script
        const message:messageType = {action: "toggle", enabled: newState};
        await chrome.tabs.sendMessage(tab.id, message);

        // store the new state
        tabData[storageKey] = {enabled: newState};
        await chrome.storage.local.set(tabData);

        // Visual feedback: swap icon or badge
        await chrome.action.setIcon({
            tabId: tab.id,
            path: newState ? enabledIcon : disabledIcon
        });

    } else {
        console.error("No tab.id or tab.url found");
        return;
    }

});