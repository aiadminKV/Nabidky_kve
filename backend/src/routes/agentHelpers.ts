export { fetchProductsBySkus } from "../services/search.js";
import type { ProductResult } from "../services/search.js";

export const slim = (r: ProductResult) => ({
  sku: r.sku,
  name: r.name,
  manufacturer_code: r.manufacturer_code,
  manufacturer: r.manufacturer,
  category: r.category,
  unit: r.unit,
  ean: r.ean,
  name_secondary: r.name_secondary,
  price: r.price,
  subcategory: r.subcategory,
  sub_subcategory: r.sub_subcategory,
  eshop_url: r.eshop_url,
});
