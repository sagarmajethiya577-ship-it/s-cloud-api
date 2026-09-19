// drive-handler.js

async function getAccessToken(clientId, clientSecret, refreshToken) {
    const response = await fetch(
        "https://oauth2.googleapis.com/token",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body:
                `client_id=${encodeURIComponent(clientId)}` +
                `&client_secret=${encodeURIComponent(clientSecret)}` +
                `&refresh_token=${encodeURIComponent(refreshToken)}` +
                `&grant_type=refresh_token`
        }
    );

    const data = await response.json();

    if (!response.ok || !data.access_token) {
        throw new Error(
            "Access Token error: " + JSON.stringify(data)
        );
    }

    return data.access_token;
}

function formatFileSize(bytes) {
    const size = Number(bytes);

    if (!Number.isFinite(size) || size <= 0) {
        return "Unknown";
    }

    if (size > 1024 * 1024 * 1024) {
        return (
            (size / (1024 * 1024 * 1024)).toFixed(2) +
            " GB"
        );
    }

    return (
        (size / (1024 * 1024)).toFixed(2) +
        " MB"
    );
}

export async function copyFileToSCloud(driveUrl, env) {
    if (!driveUrl || typeof driveUrl !== "string") {
        throw new Error("Invalid Google Drive Link");
    }

    const match = driveUrl.match(/[-\w]{25,}/);

    if (!match) {
        throw new Error("Invalid Google Drive Link");
    }

    const sourceFileId = match[0];

    // S-Cloud target Google Drive folder
    const targetFolderId =
        "1jnJkvjIE8cvvOYOvYz52VZabX5H1bvhz";

    const token = await getAccessToken(
        env.OAUTH_CLIENT_ID,
        env.OAUTH_CLIENT_SECRET,
        env.OAUTH_REFRESH_TOKEN
    );

    // ------------------------------------------
    // COPY FILE TO S-CLOUD DRIVE
    // ------------------------------------------

    const copyRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${sourceFileId}/copy?supportsAllDrives=true`,
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                parents: [targetFolderId]
            })
        }
    );

    const copyData = await copyRes.json();

    if (!copyRes.ok || copyData.error) {
        throw new Error(
            "Google API Error: " +
            (copyData.error?.message ||
                JSON.stringify(copyData))
        );
    }

    const newFileId = copyData.id;

    if (!newFileId) {
        throw new Error(
            "Google Drive Copy succeeded but no File ID returned."
        );
    }

    // ------------------------------------------
    // MAKE COPIED FILE PUBLIC
    // ------------------------------------------

    const permRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${newFileId}/permissions?supportsAllDrives=true`,
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                type: "anyone",
                role: "reader"
            })
        }
    );

    const permData = await permRes.json();

    if (!permRes.ok || permData.error) {
        throw new Error(
            "Permission Error: " +
            (permData.error?.message ||
                JSON.stringify(permData))
        );
    }

    // ------------------------------------------
    // GET COPIED FILE SIZE
    // ------------------------------------------

    let fileSize = "Unknown";

    try {
        const metaRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${newFileId}?fields=size`,
            {
                headers: {
                    "Authorization": `Bearer ${token}`
                }
            }
        );

        const metaData = await metaRes.json();

        if (metaData && metaData.size) {
            fileSize = formatFileSize(metaData.size);
        }
    } catch (e) {
        console.log(
            "Could not fetch copied file size:",
            e.message
        );
    }

    // Worker expects an object containing fileId/fileSize
    return {
    fileId: newFileId,
    fileSize: "Unknown"
    };
}
