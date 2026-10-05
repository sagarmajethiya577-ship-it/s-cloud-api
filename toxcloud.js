const TOXCLOUD_API_URL =
    "https://api.azonahub.biz/api/upload";


export async function uploadToToxCloud(
    googleDriveFileId,
    env
) {
    if (!googleDriveFileId) {
        throw new Error(
            "TOXcloud: Google Drive file ID missing."
        );
    }

    if (!env.TOXCLOUD_API_KEY) {
        throw new Error(
            "TOXcloud: TOXCLOUD_API_KEY secret missing."
        );
    }

    const driveUrl =
        `https://drive.google.com/file/d/${googleDriveFileId}/view`;

    console.log(
        `[TOXCLOUD] Upload START | drive=${googleDriveFileId}`
    );

    const response = await fetch(
        TOXCLOUD_API_URL,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-api-key":
                    env.TOXCLOUD_API_KEY
            },

            body: JSON.stringify({
                url: driveUrl
            })
        }
    );

    const text =
        await response.text();

    let data;

    try {
        data =
            JSON.parse(text);
    } catch {
        throw new Error(
            `TOXcloud invalid JSON response (${response.status}): ${text.slice(0, 500)}`
        );
    }

    if (!response.ok) {
        throw new Error(
            `TOXcloud upload failed (${response.status}): ${
                data?.message ||
                data?.error ||
                JSON.stringify(data)
            }`
        );
    }

    console.log(
        `[TOXCLOUD] Upload RESPONSE | status=${data?.status || "unknown"} | http=${response.status}`
    );

    const downloadUrl =
        data?.download_url ||
        data?.data?.download_url ||
        null;

    /*
     * TOXcloud can return a pending status.
     * In that case there is no usable download URL yet.
     */
    if (!downloadUrl) {
        console.log(
            `[TOXCLOUD] Download URL not ready | status=${data?.status || "unknown"}`
        );

        return {
            ready: false,
            download_url: null,
            status:
                data?.status ||
                "pending"
        };
    }

    console.log(
        `[TOXCLOUD] Upload SUCCESS | download_url=${downloadUrl}`
    );

    return {
        ready: true,
        download_url: downloadUrl,
        status:
            data?.status ||
            "success"
    };
}
