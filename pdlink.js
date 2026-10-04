const PDLINK_BASE =
    "https://api.pdlink.site";


// ==================================================
// QUEUE FILE ON PDLINK
// ==================================================

export async function queuePDLinkFile(
    googleDriveFileId,
    env
) {

    if (!googleDriveFileId) {
        throw new Error(
            "PDLink: Google Drive file ID missing."
        );
    }

    if (!env.PDLINK_API_KEY) {
        throw new Error(
            "PDLink: PDLINK_API_KEY secret missing."
        );
    }


    const params =
        new URLSearchParams();

    params.set(
        "fileid",
        googleDriveFileId
    );

    params.append(
        "mirror",
        "gofile"
    );

    params.append(
        "mirror",
        "pixeldrain"
    );

    params.set(
        "apikey",
        env.PDLINK_API_KEY
    );


    const apiUrl =
        `${PDLINK_BASE}/api/v2/file?${params.toString()}`;


    console.log(
        `[PDLINK] /v2/file START | file=${googleDriveFileId}`
    );


    const response =
        await fetch(
            apiUrl,
            {
                method: "GET",
                headers: {
                    "Accept":
                        "application/json"
                }
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
            `PDLink invalid JSON response (${response.status}): ${text.slice(0, 500)}`
        );

    }


    if (
        !response.ok ||
        !data.success
    ) {

        throw new Error(
            `PDLink /v2/file failed (${response.status}): ${data?.message || JSON.stringify(data)}`
        );

    }


    if (
        !data.data?.share_id
    ) {

        throw new Error(
            "PDLink /v2/file succeeded but share_id missing."
        );

    }


    console.log(
        `[PDLINK] /v2/file SUCCESS | share_id=${data.data.share_id}`
    );


    return {

        share_id:
            data.data.share_id,

        filename:
            data.data.filename ||
            null,

        size:
            data.data.size ||
            null,

        mime:
            data.data.mime ||
            null,

        already_exists:
            data.already_exists === true

    };

}


// ==================================================
// GET ONE PDLINK MIRROR LINK
// ==================================================

export async function getPDLinkMirrorLinks(
    shareId,
    env,
    mirror
) {

    if (!shareId) {

        throw new Error(
            "PDLink: share_id missing."
        );

    }


    if (!env.PDLINK_API_KEY) {

        throw new Error(
            "PDLink: PDLINK_API_KEY secret missing."
        );

    }


    if (
        mirror !== "gofile" &&
        mirror !== "pixeldrain"
    ) {

        throw new Error(
            `PDLink: Unsupported mirror "${mirror}".`
        );

    }


    const params =
        new URLSearchParams();

    params.set(
        "share_id",
        shareId
    );

    params.set(
        "mirror",
        mirror
    );

    params.set(
        "apikey",
        env.PDLINK_API_KEY
    );


    const apiUrl =
        `${PDLINK_BASE}/api/v2/link?${params.toString()}`;


    console.log(
        `[PDLINK] /v2/link START | mirror=${mirror} | share=${shareId}`
    );


    const response =
        await fetch(
            apiUrl,
            {
                method: "GET",
                headers: {
                    "Accept":
                        "application/json"
                }
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
            `PDLink ${mirror} invalid JSON response (${response.status}): ${text.slice(0, 500)}`
        );

    }


    if (
        !response.ok ||
        !data.success ||
        !data.url
    ) {

        throw new Error(
            `PDLink ${mirror} link failed (${response.status}): ${data?.message || JSON.stringify(data)}`
        );

    }


    console.log(
        `[PDLINK] /v2/link SUCCESS | mirror=${mirror}`
    );


    return data.url;

}
