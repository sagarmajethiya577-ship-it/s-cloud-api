import { copyFileToSCloud } from "./drive-handler.js";
import {
    uploadToDrivetot,
    extractLinksFromDrivetot
} from "./drivetot-scraper.js";
import { bypassGDFlix } from "./gdflix-scraper.js";


// ==================================================
// RANDOM SHORT ID GENERATOR
// ==================================================

function generateFileId(length = 8) {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    let result = "";

    for (
        let i = 0;
        i < length;
        i++
    ) {
        result += chars.charAt(
            Math.floor(
                Math.random() *
                chars.length
            )
        );
    }

    return result;
}


// ==================================================
// GOOGLE DRIVE FOLDER ID EXTRACTOR
// ==================================================

function extractFolderId(url) {
    const match =
        url.match(
            /\/folders\/([a-zA-Z0-9_-]+)/
        );

    return match
        ? match[1]
        : null;
}


// ==================================================
// GOOGLE OAUTH ACCESS TOKEN
// ==================================================

async function getAccessToken(
    clientId,
    clientSecret,
    refreshToken
) {
    const response =
        await fetch(
            "https://oauth2.googleapis.com/token",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                },
                body:
                    `client_id=${encodeURIComponent(clientId)}` +
                    `&client_secret=${encodeURIComponent(clientSecret)}` +
                    `&refresh_token=${encodeURIComponent(refreshToken)}` +
                    `&grant_type=refresh_token`
            }
        );

    const data =
        await response.json();

    if (
        !response.ok ||
        !data.access_token
    ) {
        throw new Error(
            "Access Token error: " +
            JSON.stringify(data)
        );
    }

    return data.access_token;
}


// ==================================================
// HEX HELPERS
// ==================================================

function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(
            byte =>
                byte
                    .toString(16)
                    .padStart(2, "0")
        )
        .join("");
}


function hexToBytes(hex) {
    if (
        !hex ||
        hex.length % 2 !== 0
    ) {
        throw new Error(
            "Invalid hex string"
        );
    }

    const bytes =
        new Uint8Array(
            hex.length / 2
        );

    for (
        let i = 0;
        i < hex.length;
        i += 2
    ) {
        bytes[i / 2] =
            parseInt(
                hex.slice(i, i + 2),
                16
            );
    }

    return bytes;
}


// ==================================================
// SHA-256 HASH
// ==================================================

async function sha256Hex(
    value
) {
    const data =
        new TextEncoder().encode(
            value
        );

    const hash =
        await crypto.subtle.digest(
            "SHA-256",
            data
        );

    return bytesToHex(
        new Uint8Array(hash)
    );
}


// ==================================================
// CONSTANT-TIME STRING COMPARE
// ==================================================

function safeEqual(
    a,
    b
) {
    if (
        typeof a !== "string" ||
        typeof b !== "string"
    ) {
        return false;
    }

    if (
        a.length !==
        b.length
    ) {
        return false;
    }

    let result = 0;

    for (
        let i = 0;
        i < a.length;
        i++
    ) {
        result |=
            a.charCodeAt(i) ^
            b.charCodeAt(i);
    }

    return result === 0;
}


// ==================================================
// PBKDF2 PASSWORD HASH
// ==================================================

const PBKDF2_ITERATIONS =
    100000;

const PBKDF2_SALT_BYTES =
    16;

const PBKDF2_KEY_BITS =
    256;


async function hashPassword(
    password
) {
    const salt =
        new Uint8Array(
            PBKDF2_SALT_BYTES
        );

    crypto.getRandomValues(
        salt
    );

    const passwordKey =
        await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(
                password
            ),
            {
                name: "PBKDF2"
            },
            false,
            [
                "deriveBits"
            ]
        );

    const derivedBits =
        await crypto.subtle.deriveBits(
            {
                name: "PBKDF2",
                salt: salt,
                iterations:
                    PBKDF2_ITERATIONS,
                hash: "SHA-256"
            },
            passwordKey,
            PBKDF2_KEY_BITS
        );

    const hashHex =
        bytesToHex(
            new Uint8Array(
                derivedBits
            )
        );

    const saltHex =
        bytesToHex(
            salt
        );

    return (
        "pbkdf2$" +
        PBKDF2_ITERATIONS +
        "$" +
        saltHex +
        "$" +
        hashHex
    );
}


// ==================================================
// VERIFY PASSWORD
// Supports:
// 1. PBKDF2
// 2. Old SHA-256
// ==================================================

async function verifyPassword(
    password,
    storedHash
) {
    if (
        !storedHash
    ) {
        return {
            valid: false,
            legacy: false
        };
    }


    // ----------------------------------------------
    // NEW PBKDF2 FORMAT
    // ----------------------------------------------

    if (
        storedHash.startsWith(
            "pbkdf2$"
        )
    ) {
        try {

            const parts =
                storedHash.split(
                    "$"
                );

            if (
                parts.length !== 4
            ) {
                return {
                    valid: false,
                    legacy: false
                };
            }

            const iterations =
                Number(
                    parts[1]
                );

            const saltHex =
                parts[2];

            const expectedHash =
                parts[3];

            if (
                !Number.isInteger(
                    iterations
                ) ||
                iterations < 1 ||
                !saltHex ||
                !expectedHash
            ) {
                return {
                    valid: false,
                    legacy: false
                };
            }

            const salt =
                hexToBytes(
                    saltHex
                );

            const passwordKey =
                await crypto.subtle.importKey(
                    "raw",
                    new TextEncoder().encode(
                        password
                    ),
                    {
                        name: "PBKDF2"
                    },
                    false,
                    [
                        "deriveBits"
                    ]
                );

            const derivedBits =
                await crypto.subtle.deriveBits(
                    {
                        name: "PBKDF2",
                        salt: salt,
                        iterations:
                            iterations,
                        hash: "SHA-256"
                    },
                    passwordKey,
                    PBKDF2_KEY_BITS
                );

            const actualHash =
                bytesToHex(
                    new Uint8Array(
                        derivedBits
                    )
                );

            return {
                valid:
                    safeEqual(
                        actualHash,
                        expectedHash
                    ),
                legacy: false
            };

        } catch (
            error
        ) {

            console.error(
                "PBKDF2 verification error:",
                error
            );

            return {
                valid: false,
                legacy: false
            };
        }
    }


    // ----------------------------------------------
    // OLD SHA-256 FORMAT
    // ----------------------------------------------

    if (
        /^[a-fA-F0-9]{64}$/.test(
            storedHash
        )
    ) {
        const oldHash =
            await sha256Hex(
                password
            );

        return {
            valid:
                safeEqual(
                    oldHash.toLowerCase(),
                    storedHash.toLowerCase()
                ),
            legacy: true
        };
    }


    return {
        valid: false,
        legacy: false
    };
}


// ==================================================
// SESSION TOKEN
// ==================================================

const SESSION_MAX_AGE =
    30 *
    24 *
    60 *
    60;

const SESSION_MAX_AGE_MS =
    SESSION_MAX_AGE *
    1000;


function generateSessionToken() {
    const bytes =
        new Uint8Array(
            32
        );

    crypto.getRandomValues(
        bytes
    );

    return bytesToHex(
        bytes
    );
}


// ==================================================
// COOKIE PARSER
// ==================================================

function getCookie(
    request,
    cookieName
) {
    const cookieHeader =
        request.headers.get(
            "Cookie"
        );

    if (
        !cookieHeader
    ) {
        return null;
    }

    const cookies =
        cookieHeader.split(
            ";"
        );

    for (
        const cookie of cookies
    ) {
        const index =
            cookie.indexOf("=");

        if (
            index === -1
        ) {
            continue;
        }

        const name =
            cookie
                .slice(
                    0,
                    index
                )
                .trim();

        const value =
            cookie
                .slice(
                    index + 1
                )
                .trim();

        if (
            name ===
            cookieName
        ) {
            return value;
        }
    }

    return null;
}


// ==================================================
// SESSION COOKIE
// ==================================================

function createSessionCookie(
    token
) {
    return (
        "scloud_session=" +
        token +
        "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" +
        SESSION_MAX_AGE
    );
}


function clearSessionCookie() {
    return (
        "scloud_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    );
}


// ==================================================
// CREATE SESSION
// ==================================================

async function createSession(
    userId,
    env
) {
    const rawToken =
        generateSessionToken();

    const tokenHash =
        await sha256Hex(
            rawToken
        );

    const expiresAt =
        Date.now() +
        SESSION_MAX_AGE_MS;

    await env.DB
        .prepare(
            `INSERT INTO sessions
            (
                session_token_hash,
                user_id,
                expires_at
            )
            VALUES (?, ?, ?)`
        )
        .bind(
            tokenHash,
            userId,
            expiresAt
        )
        .run();

    return {
        rawToken,
        expiresAt
    };
}


// ==================================================
// GET CURRENT USER
// ==================================================

async function getCurrentUser(
    request,
    env
) {
    const token =
        getCookie(
            request,
            "scloud_session"
        );

    if (
        !token
    ) {
        return null;
    }

    let tokenHash;

    try {
        tokenHash =
            await sha256Hex(
                token
            );
    } catch (
        error
    ) {
        return null;
    }

    const session =
        await env.DB
            .prepare(
                `SELECT
                    s.id AS session_id,
                    s.user_id AS session_user_id,
                    s.expires_at,
                    u.id,
                    u.name,
                    u.email,
                    u.role,
                    u.balance,
                    u.custom_cpm,
                    u.status,
                    u.last_login_ip,
                    u.created_at
                 FROM sessions s
                 INNER JOIN users u
                    ON u.id = s.user_id
                 WHERE
                    s.session_token_hash = ?
                 LIMIT 1`
            )
            .bind(
                tokenHash
            )
            .first();

    if (
        !session
    ) {
        return null;
    }

    const currentTime =
        Date.now();

    if (
        Number(
            session.expires_at
        ) <= currentTime
    ) {

        await env.DB
            .prepare(
                "DELETE FROM sessions WHERE id = ?"
            )
            .bind(
                session.session_id
            )
            .run();

        return null;
    }

    if (
        session.status ===
        "banned"
    ) {
        return null;
    }

    return {
        id: session.id,
        name: session.name,
        email: session.email,
        role: session.role,
        balance: session.balance,
        custom_cpm: session.custom_cpm,
        status: session.status,
        last_login_ip:
            session.last_login_ip,
        created_at:
            session.created_at
    };
}


// ==================================================
// DELETE CURRENT SESSION
// ==================================================

async function deleteCurrentSession(
    request,
    env
) {
    const token =
        getCookie(
            request,
            "scloud_session"
        );

    if (
        !token
    ) {
        return;
    }

    const tokenHash =
        await sha256Hex(
            token
        );

    await env.DB
        .prepare(
            "DELETE FROM sessions WHERE session_token_hash = ?"
        )
        .bind(
            tokenHash
        )
        .run();
}


// ==================================================
// CLEAN EXPIRED SESSIONS
// ==================================================

async function cleanExpiredSessions(
    env
) {
    try {

        await env.DB
            .prepare(
                "DELETE FROM sessions WHERE expires_at <= ?"
            )
            .bind(
                Date.now()
            )
            .run();

    } catch (
        error
    ) {
        console.error(
            "Session cleanup error:",
            error
        );
    }
}


// ==================================================
// SAFE JSON HEADERS
// ==================================================

function jsonHeaders() {
    return {
        "Content-Type":
            "application/json; charset=UTF-8",
        "Cache-Control":
            "no-store"
    };
}


// ==================================================
// MAIN WORKER
// ==================================================

export default {
    async fetch(
        request,
        env,
        ctx
    ) {

        // ------------------------------------------
        // CORS / COMMON HEADERS
        // ------------------------------------------

        const corsHeaders = {
            "Access-Control-Allow-Origin":
                "*",
            "Access-Control-Allow-Methods":
                "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":
                "Content-Type"
        };


        // ------------------------------------------
        // OPTIONS
        // ------------------------------------------

        if (
            request.method ===
            "OPTIONS"
        ) {
            return new Response(
                null,
                {
                    status: 204,
                    headers:
                        corsHeaders
                }
            );
        }


        const url =
            new URL(
                request.url
            );


        // ==================================================
        // 1. SIGNUP
        // ==================================================

        if (
            url.pathname ===
                "/api/signup" &&
            request.method ===
                "POST"
        ) {
            try {

                const body =
                    await request.json();

                const {
                    name,
                    email,
                    password
                } = body;


                if (
                    !name ||
                    !email ||
                    !password
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "All fields are required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const cleanName =
                    String(
                        name
                    ).trim();

                const cleanEmail =
                    String(
                        email
                    )
                        .trim()
                        .toLowerCase();

                const cleanPassword =
                    String(
                        password
                    );


                if (
                    cleanName.length <
                    2
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Name is too short"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    cleanName.length >
                    80
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Name is too long"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
                        cleanEmail
                    )
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Please enter a valid email address"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    cleanPassword.length <
                    8
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Password must be at least 8 characters"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    cleanPassword.length >
                    200
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Password is too long"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const existingUser =
                    await env.DB
                        .prepare(
                            "SELECT id FROM users WHERE email = ? LIMIT 1"
                        )
                        .bind(
                            cleanEmail
                        )
                        .first();


                if (
                    existingUser
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Email is already registered"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const hashedPassword =
                    await hashPassword(
                        cleanPassword
                    );


                await env.DB
                    .prepare(
                        `INSERT INTO users
                        (
                            name,
                            email,
                            password_hash,
                            role,
                            balance,
                            custom_cpm,
                            status
                        )
                        VALUES (?, ?, ?, 'publisher', 0, 1.0, 'active')`
                    )
                    .bind(
                        cleanName,
                        cleanEmail,
                        hashedPassword
                    )
                    .run();


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Account created successfully!"
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Signup Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            error?.message || String(error)
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 2. LOGIN
        // ==================================================

        if (
            url.pathname ===
                "/api/login" &&
            request.method ===
                "POST"
        ) {
            try {

                const body =
                    await request.json();

                const {
                    email,
                    password
                } = body;


                const clientIP =
                    request.headers.get(
                        "CF-Connecting-IP"
                    ) ||
                    "Unknown IP";

                const userAgent =
                    request.headers.get(
                        "User-Agent"
                    ) ||
                    "Unknown Device";


                if (
                    !email ||
                    !password
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Email and password are required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const cleanEmail =
                    String(
                        email
                    )
                        .trim()
                        .toLowerCase();


                const cleanPassword =
                    String(
                        password
                    );


                const user =
                    await env.DB
                        .prepare(
                            "SELECT * FROM users WHERE email = ? LIMIT 1"
                        )
                        .bind(
                            cleanEmail
                        )
                        .first();


                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid email or password"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                // --------------------------------------
                // CHECK PASSWORD
                // --------------------------------------

                const passwordResult =
                    await verifyPassword(
                        cleanPassword,
                        user.password_hash
                    );


                if (
                    !passwordResult.valid
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid email or password"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                // --------------------------------------
                // CHECK BANNED USER
                // --------------------------------------

                if (
                    user.status ===
                    "banned"
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Your account has been banned."
                        }),
                        {
                            status: 403,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                // --------------------------------------
                // UPGRADE OLD SHA-256 PASSWORD
                // --------------------------------------

                if (
                    passwordResult.legacy
                ) {

                    try {

                        const newPasswordHash =
                            await hashPassword(
                                cleanPassword
                            );

                        await env.DB
                            .prepare(
                                `UPDATE users
                                 SET password_hash = ?
                                 WHERE id = ?`
                            )
                            .bind(
                                newPasswordHash,
                                user.id
                            )
                            .run();

                    } catch (
                        migrationError
                    ) {

                        console.error(
                            "Password migration error:",
                            migrationError
                        );
                    }
                }


                // --------------------------------------
                // UPDATE LOGIN IP
                // --------------------------------------

                await env.DB
                    .prepare(
                        "UPDATE users SET last_login_ip = ? WHERE id = ?"
                    )
                    .bind(
                        clientIP,
                        user.id
                    )
                    .run();


                // --------------------------------------
                // LOGIN HISTORY
                // --------------------------------------

                await env.DB
                    .prepare(
                        `INSERT INTO login_history
                        (
                            user_id,
                            ip_address,
                            device_info
                        )
                        VALUES (?, ?, ?)`
                    )
                    .bind(
                        user.id,
                        clientIP,
                        userAgent
                    )
                    .run();


                // --------------------------------------
                // CREATE SESSION
                // --------------------------------------

                const session =
                    await createSession(
                        user.id,
                        env
                    );


                // --------------------------------------
                // CLEAN OLD EXPIRED SESSIONS
                // --------------------------------------

                ctx.waitUntil(
                    cleanExpiredSessions(
                        env
                    )
                );


                // --------------------------------------
                // SAFE USER DATA
                // --------------------------------------

                const userData = {
                    id:
                        user.id,
                    name:
                        user.name,
                    email:
                        user.email,
                    role:
                        user.role,
                    balance:
                        user.balance,
                    custom_cpm:
                        user.custom_cpm,
                    status:
                        user.status,
                    last_login_ip:
                        clientIP,
                    created_at:
                        user.created_at
                };


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Login successful!",
                        userData:
                            userData
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders(),
                            "Set-Cookie":
                                createSessionCookie(
                                    session.rawToken
                                )
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Login Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to login right now"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 3. CURRENT USER
        // ==================================================

        if (
            url.pathname ===
                "/api/me" &&
            request.method ===
                "GET"
        ) {
            try {

                const user =
                    await getCurrentUser(
                        request,
                        env
                    );

                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Not authenticated"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        userData:
                            user
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Me Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to verify session"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 4. LOGOUT
        // ==================================================

        if (
            url.pathname ===
                "/api/logout" &&
            request.method ===
                "POST"
        ) {
            try {

                await deleteCurrentSession(
                    request,
                    env
                );


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Logged out successfully"
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders(),
                            "Set-Cookie":
                                clearSessionCookie()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Logout Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to logout"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders(),
                            "Set-Cookie":
                                clearSessionCookie()
                        }
                    }
                );
            }
        }


        // ==================================================
        // AUTHENTICATED USER
        // ==================================================

        let currentUser =
            null;


        if (
            url.pathname ===
                "/api/files" ||
            url.pathname ===
                "/api/rename" ||
            url.pathname ===
                "/api/delete" ||
            url.pathname ===
                "/api/upload"
        ) {

            currentUser =
                await getCurrentUser(
                    request,
                    env
                );

            if (
                !currentUser
            ) {
                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Authentication required"
                    }),
                    {
                        status: 401,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 5. GET FILES
        // ==================================================

        if (
            url.pathname ===
                "/api/files" &&
            request.method ===
                "POST"
        ) {
            try {

                const {
                    results
                } =
                    await env.DB
                        .prepare(
                            `SELECT *
                             FROM files
                             WHERE user_id = ?
                             ORDER BY created_at DESC`
                        )
                        .bind(
                            currentUser.id
                        )
                        .all();


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        data:
                            results
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            error.message
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 6. RENAME FILE
        // ==================================================

        if (
            url.pathname ===
                "/api/rename" &&
            request.method ===
                "POST"
        ) {
            try {

                const body =
                    await request.json();

                const {
                    file_id,
                    new_name
                } = body;


                if (
                    !file_id ||
                    !new_name
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "File ID and new name are required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const cleanName =
                    String(
                        new_name
                    ).trim();


                if (
                    !cleanName
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "New name cannot be empty"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    cleanName.length >
                    255
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "File name is too long"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const result =
                    await env.DB
                        .prepare(
                            `UPDATE files
                             SET file_name = ?,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE
                                (id = ? OR short_id = ?)
                                AND user_id = ?
                                AND status != 'deleted'`
                        )
                        .bind(
                            cleanName,
                            file_id,
                            file_id,
                            currentUser.id
                        )
                        .run();


                if (
                    (result.meta?.changes ??
                        0) === 0
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "File not found"
                        }),
                        {
                            status: 404,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Renamed successfully!",
                        changes:
                            result.meta?.changes ??
                            0
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            error.message
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 7. DELETE FILE
        // ==================================================

        if (
            url.pathname ===
                "/api/delete" &&
            request.method ===
                "POST"
        ) {
            try {

                const body =
                    await request.json();

                const {
                    file_id
                } = body;


                if (
                    !file_id
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "File ID is required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const result =
                    await env.DB
                        .prepare(
                            `UPDATE files
                             SET status = 'deleted',
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE
                                (id = ? OR short_id = ?)
                                AND user_id = ?
                                AND status != 'deleted'`
                        )
                        .bind(
                            file_id,
                            file_id,
                            currentUser.id
                        )
                        .run();


                if (
                    (result.meta?.changes ??
                        0) === 0
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "File not found"
                        }),
                        {
                            status: 404,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Deleted successfully!"
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            error.message
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 8. UPLOAD
        // ==================================================

        if (
            url.pathname ===
                "/api/upload" &&
            request.method ===
                "POST"
        ) {
            try {

                const body =
                    await request.json();

                const {
                    drive_url
                } = body;


                if (
                    !drive_url
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Google Drive URL required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                let cleanUrl =
                    String(
                        drive_url
                    ).trim();


                // --------------------------------------
                // GOOGLE DRIVE FOLDER
                // --------------------------------------

                if (
                    cleanUrl.includes(
                        "/drive/folders/"
                    )
                ) {
                    const folderId =
                        extractFolderId(
                            cleanUrl
                        );


                    if (
                        !folderId
                    ) {
                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "Invalid Google Drive Folder ID!"
                            }),
                            {
                                status: 400,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }


                    try {

                        const token =
                            await getAccessToken(
                                env.OAUTH_CLIENT_ID,
                                env.OAUTH_CLIENT_SECRET,
                                env.OAUTH_REFRESH_TOKEN
                            );


                        const listRes =
                            await fetch(
                                `https://www.googleapis.com/drive/v3/files?q='${encodeURIComponent(folderId)}'+in+parents&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,size,mimeType)`,
                                {
                                    headers: {
                                        "Authorization":
                                            `Bearer ${token}`
                                    }
                                }
                            );


                        const listData =
                            await listRes.json();


                        if (
                            !listRes.ok
                        ) {
                            throw new Error(
                                listData.error?.message ||
                                "Google Drive folder API error"
                            );
                        }


                        if (
                            !listData.files ||
                            listData.files.length ===
                                0
                        ) {
                            return new Response(
                                JSON.stringify({
                                    status:
                                        "error",
                                    message:
                                        "No files found inside this folder."
                                }),
                                {
                                    status: 400,
                                    headers: {
                                        ...corsHeaders,
                                        ...jsonHeaders()
                                    }
                                }
                            );
                        }


                        cleanUrl =
                            `https://drive.google.com/file/d/${listData.files[0].id}/view`;

                    } catch (
                        err
                    ) {

                        console.error(
                            "Folder Error:",
                            err
                        );

                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "Failed to read folder contents via Google API."
                            }),
                            {
                                status: 400,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }
                }


                // --------------------------------------
                // VALIDATE GOOGLE DRIVE LINK
                // --------------------------------------

                const match =
                    cleanUrl.match(
                        /[-\w]{25,}/
                    );


                if (
                    !cleanUrl.includes(
                        "drive.google.com"
                    ) ||
                    !match
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid Google Drive Link format!"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const sourceFileId =
                    match[0];


                // --------------------------------------
                // GET SOURCE FILE METADATA
                // --------------------------------------

                let actualFileName =
                    "Unknown File";

                let exactFileSize =
                    "Unknown";


                try {

                    const token =
                        await getAccessToken(
                            env.OAUTH_CLIENT_ID,
                            env.OAUTH_CLIENT_SECRET,
                            env.OAUTH_REFRESH_TOKEN
                        );


                    const metaRes =
                        await fetch(
                            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}?fields=name,size,mimeType&supportsAllDrives=true`,
                            {
                                headers: {
                                    "Authorization":
                                        `Bearer ${token}`
                                }
                            }
                        );


                    const metaData =
                        await metaRes.json();


                    if (
                        !metaRes.ok
                    ) {
                        throw new Error(
                            metaData.error?.message ||
                            "Google Drive metadata error"
                        );
                    }


                    if (
                        metaData &&
                        metaData.name
                    ) {

                        actualFileName =
                            metaData.name;


                        if (
                            metaData.size
                        ) {

                            const bytes =
                                Number(
                                    metaData.size
                                );


                            if (
                                bytes >
                                1024 *
                                1024 *
                                1024
                            ) {

                                exactFileSize =
                                    (
                                        bytes /
                                        (
                                            1024 *
                                            1024 *
                                            1024
                                        )
                                    ).toFixed(
                                        2
                                    ) +
                                    " GB";

                            } else {

                                exactFileSize =
                                    (
                                        bytes /
                                        (
                                            1024 *
                                            1024
                                        )
                                    ).toFixed(
                                        2
                                    ) +
                                    " MB";
                            }
                        }

                    } else {

                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "Drive file not found or private! Make sure it's accessible."
                            }),
                            {
                                status: 400,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }

                } catch (
                    e
                ) {

                    console.error(
                        "Drive Metadata Error:",
                        e
                    );

                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Could not verify Google Drive file via API."
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                // --------------------------------------
                // CREATE SHORT ID
                // --------------------------------------

                const shortId =
                    generateFileId();


                const currentTime =
                    Date.now();


                const short_link =
                    `https://${url.hostname}/file/${shortId}`;


                // --------------------------------------
                // INSERT FILE RECORD
                // --------------------------------------

                await env.DB
                    .prepare(
                        `INSERT INTO files
                        (
                            id,
                            short_id,
                            user_id,
                            file_name,
                            file_size,
                            drive_url,
                            last_updated,
                            status
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                    )
                    .bind(
                        shortId,
                        shortId,
                        currentUser.id,
                        actualFileName,
                        exactFileSize,
                        cleanUrl,
                        currentTime,
                        "active"
                    )
                    .run();


                // --------------------------------------
                // BACKGROUND PROCESSING
                // --------------------------------------

                ctx.waitUntil(
                    (async () => {

                        try {

                            // =================================
                            // STEP 1 - COPY TO S-CLOUD DRIVE
                            // =================================

                            const scloudResult =
                                await copyFileToSCloud(
                                    cleanUrl,
                                    env
                                );


                            if (
                                !scloudResult ||
                                !scloudResult.fileId
                            ) {
                                throw new Error(
                                    "S-Cloud Copy Failed"
                                );
                            }


                            const scloudFileId =
                                scloudResult.fileId;


                            if (
                                scloudResult.fileSize &&
                                scloudResult.fileSize !==
                                    "Unknown"
                            ) {

                                await env.DB
                                    .prepare(
                                        `UPDATE files
                                         SET file_size = ?
                                         WHERE id = ?`
                                    )
                                    .bind(
                                        scloudResult.fileSize,
                                        shortId
                                    )
                                    .run();
                            }


                            // =================================
                            // STEP 2 - DRIVETOT
                            // =================================

                            const drivetotResult =
                                await uploadToDrivetot(
                                    scloudFileId,
                                    env
                                );


                            if (
                                !drivetotResult ||
                                !drivetotResult.share_id
                            ) {
                                throw new Error(
                                    "Drivetot Upload Failed"
                                );
                            }


                            const drivetot_url =
                                `https://drivetot.website/s/${drivetotResult.share_id}`;


                            await env.DB
                                .prepare(
                                    `UPDATE files
                                     SET drivetot_url = ?
                                     WHERE id = ?`
                                )
                                .bind(
                                    drivetot_url,
                                    shortId
                                )
                                .run();


                            // =================================
                            // STEP 3 - EXTRACT LINKS
                            // =================================

                            const extractedLinks =
                                await extractLinksFromDrivetot(
                                    drivetotResult.share_id,
                                    env
                                );


                            if (
                                extractedLinks.error
                            ) {
                                throw new Error(
                                    "Drivetot Scraper Failed: " +
                                    extractedLinks.error
                                );
                            }


                            const hubcloud_url =
                                extractedLinks.hubcloud_url ||
                                "Not Found";


                            const gdflix_url =
                                extractedLinks.gdflix_url;


                            await env.DB
                                .prepare(
                                    `UPDATE files
                                     SET hubcloud_url = ?,
                                         gdflix_url = ?
                                     WHERE id = ?`
                                )
                                .bind(
                                    hubcloud_url,
                                    gdflix_url,
                                    shortId
                                )
                                .run();


                            console.log(
                                `Background processing completed: ${shortId}`
                            );

                        } catch (
                            bgErr
                        ) {

                            console.error(
                                "Background processing error for " +
                                shortId +
                                ":",
                                bgErr.message
                            );
                        }

                    })()
                );


                // --------------------------------------
                // INSTANT RESPONSE
                // --------------------------------------

                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "File Verified & Uploaded Instantly!",
                        data: {
                            file_name:
                                actualFileName,
                            file_size:
                                exactFileSize,
                            short_id:
                                shortId,
                            short_link:
                                short_link
                        }
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Upload Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            error.message
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 9. PUBLIC DOWNLOAD ROUTE
        // ==================================================

        if (
            url.pathname.startsWith(
                "/file/"
            )
        ) {

            const shortId =
                url.pathname
                    .split(
                        "/"
                    )[2];


            if (
                !shortId
            ) {
                return new Response(
                    "Invalid Link",
                    {
                        status: 400,
                        headers:
                            corsHeaders
                    }
                );
            }


            try {

                // ------------------------------------------
                // FIND FILE
                // ------------------------------------------

                let record =
                    await env.DB
                        .prepare(
                            `SELECT *
                             FROM files
                             WHERE short_id = ?
                                OR id = ?`
                        )
                        .bind(
                            shortId,
                            shortId
                        )
                        .first();


                if (
                    !record
                ) {
                    return new Response(
                        "File Not Found in DB",
                        {
                            status: 404,
                            headers:
                                corsHeaders
                        }
                    );
                }


                if (
                    record.status ===
                    "deleted"
                ) {
                    return new Response(
                        "This file has been removed.",
                        {
                            status: 403,
                            headers:
                                corsHeaders
                        }
                    );
                }


                const currentTime =
                    Date.now();


                const THREE_HOURS_IN_MS =
                    3 *
                    60 *
                    60 *
                    1000;


                // ------------------------------------------
                // INCREMENT VIEWS
                // ------------------------------------------

                await env.DB
                    .prepare(
                        `UPDATE files
                         SET views = COALESCE(views, 0) + 1
                         WHERE id = ?`
                    )
                    .bind(
                        record.id
                    )
                    .run();


                let selfHealingError =
                    "No processing error detected.";


                // ==================================================
                // SELF-HEALING
                // ==================================================

                if (
                    !record.gdflix_url &&
                    record.drive_url
                ) {

                    try {

                        // --------------------------------------
                        // STEP 1
                        // --------------------------------------

                        const scloudResult =
                            await copyFileToSCloud(
                                record.drive_url,
                                env
                            );


                        if (
                            !scloudResult ||
                            !scloudResult.fileId
                        ) {
                            throw new Error(
                                "Step 1 Failed: S-Cloud Drive Copy Failed. Check OAuth Tokens."
                            );
                        }


                        const scloudFileId =
                            scloudResult.fileId;


                        if (
                            scloudResult.fileSize &&
                            scloudResult.fileSize !==
                                "Unknown"
                        ) {

                            await env.DB
                                .prepare(
                                    `UPDATE files
                                     SET file_size = ?
                                     WHERE id = ?`
                                )
                                .bind(
                                    scloudResult.fileSize,
                                    record.id
                                )
                                .run();


                            record.file_size =
                                scloudResult.fileSize;
                        }


                        // --------------------------------------
                        // STEP 2
                        // --------------------------------------

                        const drivetotResult =
                            await uploadToDrivetot(
                                scloudFileId,
                                env
                            );


                        if (
                            !drivetotResult ||
                            !drivetotResult.share_id
                        ) {
                            throw new Error(
                                "Step 2 Failed: Drivetot API rejected the upload. Check DRIVETOT_API_KEY."
                            );
                        }


                        const drivetot_url =
                            `https://drivetot.website/s/${drivetotResult.share_id}`;


                        // --------------------------------------
                        // STEP 3
                        // --------------------------------------

                        const extractedLinks =
                            await extractLinksFromDrivetot(
                                drivetotResult.share_id,
                                env
                            );


                        if (
                            extractedLinks.error
                        ) {
                            throw new Error(
                                "Step 3 Failed: Drivetot Scraper Error -> " +
                                extractedLinks.error
                            );
                        }


                        record.hubcloud_url =
                            extractedLinks.hubcloud_url ||
                            "Not Found";


                        record.gdflix_url =
                            extractedLinks.gdflix_url;


                        record.drivetot_url =
                            drivetot_url;


                        await env.DB
                            .prepare(
                                `UPDATE files
                                 SET drivetot_url = ?,
                                     hubcloud_url = ?,
                                     gdflix_url = ?
                                 WHERE id = ?`
                            )
                            .bind(
                                record.drivetot_url,
                                record.hubcloud_url,
                                record.gdflix_url,
                                record.id
                            )
                            .run();

                    } catch (
                        healErr
                    ) {

                        selfHealingError =
                            healErr.message;


                        console.error(
                            "Self-Healing Error:",
                            healErr.message
                        );
                    }
                }


                // ==================================================
                // SERVE FAST LINKS FROM CACHE
                // ==================================================

                const lastUpdated =
                    Number(
                        record.last_updated ||
                        0
                    );


                if (
                    record.fast_links &&
                    lastUpdated > 0 &&
                    (
                        currentTime -
                        lastUpdated
                    ) <
                        THREE_HOURS_IN_MS
                ) {

                    let parsedLinks;


                    try {

                        parsedLinks =
                            JSON.parse(
                                record.fast_links
                            );

                    } catch (
                        e
                    ) {

                        parsedLinks =
                            record.fast_links;
                    }


                    return new Response(
                        JSON.stringify(
                            {
                                status:
                                    "Success (Served from Cache)",

                                file_name:
                                    record.file_name,

                                file_size:
                                    record.file_size,

                                drivetot_url:
                                    record.drivetot_url,

                                hubcloud_url:
                                    record.hubcloud_url,

                                gdflix_url:
                                    record.gdflix_url,

                                download_links:
                                    parsedLinks
                            },
                            null,
                            2
                        ),
                        {
                            status: 200,
                            headers: {
                                "Content-Type":
                                    "application/json",
                                ...corsHeaders
                            }
                        }
                    );
                }


                // ==================================================
                // NO GDFLIX LINK
                // ==================================================

                if (
                    !record.gdflix_url
                ) {

                    return new Response(
                        JSON.stringify(
                            {
                                status:
                                    "Processing Error",

                                message:
                                    "Background process is failing. Check the detailed reason below.",

                                detailed_reason:
                                    selfHealingError
                            },
                            null,
                            2
                        ),
                        {
                            status: 400,
                            headers: {
                                "Content-Type":
                                    "application/json",
                                ...corsHeaders
                            }
                        }
                    );
                }


                // ==================================================
                // FRESH GDFLIX SCRAPE
                // ==================================================

                try {

                    const freshFastLinks =
                        await bypassGDFlix(
                            record.gdflix_url,
                            env
                        );


                    // --------------------------------------
                    // SAVE FAST LINKS
                    // --------------------------------------

                    const expiresAt =
                        currentTime +
                        THREE_HOURS_IN_MS;


                    await env.DB
                        .prepare(
                            `UPDATE files
                             SET fast_links = ?,
                                 last_updated = ?,
                                 fast_links_expires_at = ?
                             WHERE id = ?`
                        )
                        .bind(
                            JSON.stringify(
                                freshFastLinks
                            ),
                            currentTime,
                            expiresAt,
                            record.id
                        )
                        .run();


                    return new Response(
                        JSON.stringify(
                            {
                                status:
                                    "Success (Freshly Scraped)",

                                file_name:
                                    record.file_name,

                                file_size:
                                    record.file_size,

                                drivetot_url:
                                    record.drivetot_url,

                                hubcloud_url:
                                    record.hubcloud_url,

                                gdflix_url:
                                    record.gdflix_url,

                                download_links:
                                    freshFastLinks
                            },
                            null,
                            2
                        ),
                        {
                            status: 200,
                            headers: {
                                "Content-Type":
                                    "application/json",
                                ...corsHeaders
                            }
                        }
                    );

                } catch (
                    scrapingError
                ) {

                    return new Response(
                        JSON.stringify({
                            status:
                                "Scraping Failed",
                            error:
                                scrapingError.message
                        }),
                        {
                            status: 500,
                            headers: {
                                "Content-Type":
                                    "application/json",
                                ...corsHeaders
                            }
                        }
                    );
                }

            } catch (
                err
            ) {

                console.error(
                    "Download Route Error:",
                    err
                );

                return new Response(
                    "DB Error: " +
                    err.message,
                    {
                        status: 500,
                        headers:
                            corsHeaders
                    }
                );
            }
        }


        // ==================================================
        // STATIC FRONTEND
        // ==================================================

        if (
            env.ASSETS &&
            typeof env.ASSETS.fetch ===
                "function"
        ) {
            return env.ASSETS.fetch(
                request
            );
        }


        // ==================================================
        // DEFAULT RESPONSE
        // ==================================================

        return new Response(
            "S-Cloud Dashboard Mega Engine is Live!",
            {
                status: 200,
                headers:
                    corsHeaders
            }
        );
    }
};
