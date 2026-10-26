<#import "footer.ftl" as loginFooter>
<#--
  Techzaz EMS sign-in layout. Same macro contract as Keycloak's base template.ftl
  (sections: header, show-username, form, socialProviders, info), so every built-in
  login page (sign in, reset password, update password, OTP, verify email, …) uses it.
-->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="tz-html" lang="${lang}"<#if realm.internationalizationEnabled> dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <title>${msg("loginTitle",(realm.displayName!''))}</title>
    <link rel="icon" type="image/png" href="${url.resourcesPath}/img/favicon.png" />
    <link rel="preload" href="${url.resourcesPath}/fonts/montserrat-600.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="${url.resourcesPath}/fonts/jakarta.woff2" as="font" type="font/woff2" crossorigin />
    <#if properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="importmap">
        { "imports": { "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js" } }
    </script>
    <script src="${url.resourcesPath}/js/menu-button-links.js" type="module"></script>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="module">
        import { startSessionPolling } from "${url.resourcesPath}/js/authChecker.js";
        startSessionPolling("${url.ssoLoginInOtherTabsUrl?no_esc}");
    </script>
    <script type="module">
        document.addEventListener("click", (event) => {
            const link = event.target.closest("a[data-once-link]");
            if (!link) return;
            if (link.getAttribute("aria-disabled") === "true") { event.preventDefault(); return; }
            const { disabledClass } = link.dataset;
            if (disabledClass) link.classList.add(...disabledClass.trim().split(/\s+/));
            link.setAttribute("role", "link");
            link.setAttribute("aria-disabled", "true");
        });
    </script>
    <#if authenticationSession??>
        <script type="module">
            import { checkAuthSession } from "${url.resourcesPath}/js/authChecker.js";
            checkAuthSession("${authenticationSession.authSessionIdHash}");
        </script>
    </#if>
</head>

<body class="tz ${bodyClass}" data-page-id="login-${pageId}">
<div class="tz-canvas" aria-hidden="true"><div class="tz-glow"></div></div>

<header class="tz-top">
    <span class="tz-wordmark">
        <img src="${url.resourcesPath}/img/logo-mark.png" alt="" width="42" height="30" />
        <span><span class="tz-thin">TECHZAZ</span><span class="tz-thin">+</span><b>EMS</b></span>
    </span>
    <span class="tz-toppanel">Centralized sign-in</span>
</header>

<#assign heroRaw><#nested "header"></#assign>
<#assign heroWords = heroRaw?markup_string?replace("<[^>]+>", " ", "r")?trim?split("\\s+", "r")>

<main class="tz-main">
    <section class="tz-hero" aria-hidden="true">
        <p class="tz-eyebrow">Techzaz Networks · Information is power</p>
        <div class="tz-mega"><#list heroWords as w><span class="tz-w"><span style="animation-delay:${120 + w?index * 95}ms">${w?no_esc}</span></span><#sep> </#sep></#list><span class="tz-w"><span style="animation-delay:${120 + heroWords?size * 95}ms">.</span></span></div>
    </section>

    <section class="tz-panel">
        <div class="tz-window">
            <div class="tz-dots" aria-hidden="true"><i></i><i></i><i></i></div>
            <div class="tz-card">
                <header class="tz-card-head">
                <#if !(auth?has_content && auth.showUsername() && !auth.showResetCredentials())>
                    <h1 id="kc-page-title"><#nested "header"></h1>
                    <#if displayRequiredFields>
                        <p class="tz-required"><span class="required">*</span> ${msg("requiredFields")}</p>
                    </#if>
                <#else>
                    <#nested "show-username">
                    <div id="kc-username" class="tz-username">
                        <#assign au = auth.attemptedUsername!''>
                        <span class="tz-avatar" aria-hidden="true">${au?has_content?then(au[0]?upper_case, '?')}</span>
                        <label id="kc-attempted-username">${auth.attemptedUsername}</label>
                        <a id="reset-login" href="${url.loginRestartFlowUrl}" aria-label="${msg("restartLoginTooltip")}">${msg("restartLoginTooltip")}</a>
                    </div>
                    <#if displayRequiredFields>
                        <p class="tz-required"><span class="required">*</span> ${msg("requiredFields")}</p>
                    </#if>
                </#if>
                </header>

                <div id="kc-content">
                    <div id="kc-content-wrapper">
                        <#-- App-initiated actions should not see warnings about the need to complete the action during login. -->
                        <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                            <div class="tz-alert tz-alert-${message.type}" role="alert">
                                <span class="tz-alert-dot" aria-hidden="true"></span>
                                <span class="kc-feedback-text">${kcSanitize(message.summary)?no_esc}</span>
                            </div>
                        </#if>

                        <#nested "form">

                        <#if auth?has_content && auth.showTryAnotherWayLink()>
                            <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post">
                                <div class="${properties.kcFormGroupClass!}">
                                    <input type="hidden" name="tryAnotherWay" value="on"/>
                                    <a href="#" id="try-another-way"
                                       onclick="document.forms['kc-select-try-another-way-form'].requestSubmit();return false;">${msg("doTryAnotherWay")}</a>
                                </div>
                            </form>
                        </#if>

                        <#nested "socialProviders">

                        <#if displayInfo>
                            <div id="kc-info" class="tz-info">
                                <div id="kc-info-wrapper"><#nested "info"></div>
                            </div>
                        </#if>
                    </div>
                </div>
                <@loginFooter.content/>
            </div>
        </div>
        <p class="tz-legal">Access is monitored. Trouble signing in? Contact <a href="mailto:soc@techzaz.lk">soc@techzaz.lk</a></p>
    </section>
</main>
</body>
</html>
</#macro>
