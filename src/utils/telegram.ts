interface TelegramWebAppLike {
    ready?: () => void;
    expand?: () => void;
    setHeaderColor?: (color: string) => void;
    setBackgroundColor?: (color: string) => void;
    initData?: string;
    initDataUnsafe?: object;
    colorScheme?: "light" | "dark";
    version?: string;
}

const getWebApp = (): TelegramWebAppLike | null => {
    try {
        const anyWindow = window as any;
        return (anyWindow.Telegram?.WebApp as TelegramWebAppLike) ?? null;
    } catch {
        return null;
    }
};

// Приложение встроено в Telegram Mini Apps, если в URL есть инициализационные
// данные Telegram (#tgWebAppData=...) либо доступен объект WebApp с initData.
// Детекция по хэшу обязательна: вне Telegram объект WebApp может отсутствовать,
// а если подключить официальный SDK-скрипт, он появится и в обычном браузере
// (с пустым initData). По хэшу же можно однозначно понять, что мы в Telegram.
export const IS_TELEGRAM: boolean = (() => {
    try {
        if (typeof window === "undefined") return false;
        if ((window.location.hash || "").includes("tgWebAppData=")) return true;
        const wa = getWebApp();
        return !!(wa && wa.initData);
    } catch {
        return false;
    }
})();

export const initTelegram = (): void => {
    if (!IS_TELEGRAM) return;
    const tg = getWebApp();
    if (!tg || !tg.ready) return;

    tg.ready();
    tg.expand?.();
    try {
        // Согласуем «окружение» Telegram (шапка/фон) с тёмной темой приложения.
        tg.setHeaderColor?.("#1e2337");
        tg.setBackgroundColor?.("#1e2337");
    } catch {
        // игнорируем: методы опциональны в старых версиях
    }
};
