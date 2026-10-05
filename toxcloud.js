const TOXCLOUD_API_URL =
    "https://cloud.azonahub.biz/api/upload";

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
            "TOXcloud: TOXcloud_API_KEY secret missing."
        );
    }

    const driveUrl =
        `https://drive.google.com/file/d/${googleDriveFileId}/view`;

    const params = new URLSearchParams();

    params.set(
        "key",
        env.TOXCLOUD_API_KEY
    );

    params.set(
        "id",
        driveUrl
    );

    const apiUrl =
        `${TOXCLOUD_API_URL}?${params.toString()}`;

    console.log(
        `[TOXCLOUD] Upload START | drive=${googleDriveFileId}`
    );

    const response = await fetch(
        apiUrl,
        {
            method: "GET",
            headers: {
                "Accept": "application/json"
            }
        }
    );

    const text =
        await response.text();

    let data;

    try {
        data = JSON.parse(text);
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

    const downloadUrl =
        data?.download_url ||
        data?.data?.download_url ||
        null;

    console.log(
        `[TOXCLOUD] Upload RESPONSE | http=${response.status} | status=${data?.status || "unknown"} | exists=${data?.exists === true}`
    );

    /*
     * IMPORTANT:
     * TOXcloud can return status=pending/processing while
     * already providing a usable download_url.
     *
     * download_url is therefore the authoritative signal
     * for saving the TOXcloud link.
     */
    if (downloadUrl) {
        console.log(
            `[TOXCLOUD] Download URL AVAILABLE | status=${data?.status || "unknown"} | url=${downloadUrl}`
        );

        return {
            ready: true,
            download_url: downloadUrl,
            status:
                data?.status ||
                "available",
            toxcloud_id:
                data?.id ||
                null,
            exists:
                data?.exists === true
        };
    }

    console.log(
        `[TOXCLOUD] Download URL NOT AVAILABLE | status=${data?.status || "unknown"}`
    );

    return {
        ready: false,
        download_url: null,
        status:
            data?.status ||
            "unknown",
        toxcloud_id:
            data?.id ||
            null,
        exists:
            data?.exists === true
    };
}
