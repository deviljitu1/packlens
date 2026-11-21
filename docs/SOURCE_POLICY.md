# Source policy

Access permission, match identity, image quality and commercial reuse permission are independent fields. A searchable page, downloadable file or Codex assertion does not establish image ownership.

Prefer user-owned photographs, authorized manufacturer/supplier assets and documented public catalog APIs. Public Open Food Facts-family adapters respect per-source throttles and record product metadata/barcodes. Images remain UNVERIFIED until per-image reuse conditions, evidence and verifier are recorded. Image licenses can impose attribution/share-alike requirements and packaging may involve other rights.

The Codex browser researcher can discover product and policy URLs without user-supplied product links. A new source must expose affirmative policy evidence that the app can verify in the published page. Unknown or contradictory policy becomes an exception. Discovered retailer/marketplace domains are not silently authorized.

On 401/403, rate-limit challenges, CAPTCHA or access denial: stop that source and back off. HTTP 503 is a temporary service failure and receives a cooldown. Preserve the original error and retry time. Skip paused sources without recursively appending errors or extending backoff. Retry at most twice after recorded source backoff. Do not rotate proxies, use stealth or bypass login/CAPTCHA.

Retailer adapters (Amazon, Flipkart, JioMart, DMart Ready, BigBasket, Blinkit) are disabled by default. Their presence in Settings does not mean their integrations work or that reuse is licensed.

Official references:

- [Public API limits and usage](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/)
- [Image/database license distinctions](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/)
- [Other Open Facts catalogs](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/scanning-cosmetics-pet-food-and-other-products/)
- [Codex non-interactive image/JSON workflow](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex account quota reporting](https://learn.chatgpt.com/docs/app-server)
