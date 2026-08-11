import i18next, { DefaultNamespace, Namespace, TFunction } from "i18next";
import I18NextFsBackend from "i18next-fs-backend";
import path from "node:path";

export interface ITextService {
    get: <Ns extends Namespace = DefaultNamespace, KPrefix = undefined>(
        ...tArgs: Parameters<TFunction<Ns, KPrefix>>
    ) => string;
}

export class TextServiceError extends Error {}

export interface TextServiceOptions {
    /** Active language. Defaults to "ru", matching bschat-bot's default. */
    lng?: string;
    fallbackLng?: string;
    /**
     * Directory containing `<lng>.json` locale files. Defaults to
     * `<cwd>/locales`, same as the old bschat-bot behavior - each bot is
     * expected to ship its own `locales/` directory next to where it runs.
     */
    localesDir?: string;
}

/**
 * i18next-backed translation lookup.
 *
 * Ported from bschat-bot's `TextService`
 * (src/modules/common/text.service.ts) - same i18next-fs-backend setup and
 * `get()` behavior (random pick on array values, throws in non-production
 * when a key is missing, falls back to returning the key itself in
 * production). Dropped the Inversify `@injectable()` decorator and made the
 * locale directory/language configurable instead of hardcoded, since this is
 * now shared across multiple bots rather than baked into one app.
 */
export class TextService implements ITextService {
    constructor(options: TextServiceOptions = {}) {
        const {
            lng = "ru",
            fallbackLng = "ru",
            localesDir = path.join(process.cwd(), "locales"),
        } = options;

        i18next.use(I18NextFsBackend).init({
            lng,
            fallbackLng,
            backend: {
                loadPath: path.join(localesDir, "{{lng}}.json"),
            },
            interpolation: {
                escapeValue: false,
            },
            returnObjects: true,
        });
    }

    public get = <Ns extends Namespace = DefaultNamespace, KPrefix = undefined>(
        ...tArgs: Parameters<TFunction<Ns, KPrefix>>
    ) => {
        const key = tArgs[0];
        const options = (typeof tArgs[1] === "object" ? tArgs[1] : {}) as Record<
            string,
            unknown
        >;

        const value = i18next.t(key, {
            ...options,
        });

        if (!value) {
            if (process.env["NODE_ENV"] === "production") {
                console.error(`Translation for ${String(key)} not found`);
                return key as string;
            }
            throw new TextServiceError(`Translation for ${String(key)} not found`);
        }

        if (Array.isArray(value)) {
            return value[Math.floor(Math.random() * value.length)];
        } else {
            return value;
        }
    };
}
