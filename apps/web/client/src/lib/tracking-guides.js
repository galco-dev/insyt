// Where the tracking code goes, per website builder, in the customer's own
// words. The crawler names the builder; anything else gets the general steps.
export const GUIDES = {
  wix: { name: 'Wix', steps: ['Open your Wix dashboard and go to Settings.', 'Choose Custom code, then Add custom code.', 'Paste the code, name it "Insyt tracking", pick "All pages" and "Head".', 'Tap Apply. Done.'] },
  squarespace: { name: 'Squarespace', steps: ['Open Settings, then Advanced, then Code injection.', 'Paste the code in the Header box.', 'Tap Save. Done.'] },
  webflow: { name: 'Webflow', steps: ['Open your project settings and choose Custom code.', 'Paste the code in the Head code box.', 'Save, then publish your site. Done.'] },
  wordpress: { name: 'WordPress', steps: ['If you use a plugin for header code (Insert Headers and Footers, or your theme\'s settings), paste the code in its Header box and save.', 'Otherwise open Appearance, Theme file editor, header.php, and paste it just before the closing head tag.', 'Save. Done.'] },
  shopify: { name: 'Shopify', steps: ['Open Online store, then Themes, then Edit code.', 'Open theme.liquid and paste the code just before the closing head tag.', 'Save. Done.'] },
  other: { name: 'your website', steps: ['Open the file or setting that controls the top of every page (often called the header or head).', 'Paste the code just before the closing head tag.', 'Save and publish. Done.'] },
};

export const guideFor = (platform) => GUIDES[platform] || GUIDES.other;

// The standard Google Tag Manager loader for one id.
export const codeFor = (id) => `<!-- Insyt tracking -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');</script>
<!-- End Insyt tracking -->`;
