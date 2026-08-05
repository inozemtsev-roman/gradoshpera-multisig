interface TelegramWebAppLike {
    ready: () => void;
    expand: () => void;
    setHeaderColor?: (color: string) => void;
    setBackgroundColor?: (color: string) => void;
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

// Приложение встроено в Telegram Mini Apps: window.Telegram.WebApp внедряется
// нативно в вебвью. Вне Telegram объект отсутствует — детекция по его наличию.
export const IS_TELEGRAM: boolean =
    typeof window !== "undefined" && !!getWebApp();

export const initTelegram = (): void => {
    if (!IS_TELEGRAM) return;
    const tg = getWebApp();
    if (!tg) return;

    tg.ready();
    tg.expand();
    try {
        // Согласуем «окружение» Telegram (шапка/фон) с тёмной темой приложения.
        tg.setHeaderColor?.("#1e2337");
        tg.setBackgroundColor?.("#1e2337");
    } catch {
        // игнорируем: методы опциональны в старых версиях
    }
};
