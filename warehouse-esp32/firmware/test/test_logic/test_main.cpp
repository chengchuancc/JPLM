#include <unity.h>
#include "terminal_logic.h"

void test_scan_crlf_and_next_frame() {
  ScanFrame f;
  for (char c : "JC210001") if (c) TEST_ASSERT_FALSE(f.feed(c));
  TEST_ASSERT_TRUE(f.feed('\r'));
  TEST_ASSERT_EQUAL_STRING("JC210001", f.data());
  f.reset();
  TEST_ASSERT_FALSE(f.feed('\n'));
  f.feed('X'); TEST_ASSERT_TRUE(f.finish());
  TEST_ASSERT_EQUAL_STRING("X", f.data());
}
void test_scan_overflow_and_control_char_rejected() {
  ScanFrame f;
  for (unsigned i = 0; i < 513; ++i) f.feed('A');
  TEST_ASSERT_FALSE(f.feed('\n')); // never submit truncated material identity
  f.feed('B'); f.feed('\0'); f.feed('C');
  TEST_ASSERT_FALSE(f.finish());
  f.feed('D'); TEST_ASSERT_TRUE(f.finish());
  TEST_ASSERT_EQUAL_STRING("D", f.data());
}
void test_matrix_layout_and_multikey_rejection() {
  TEST_ASSERT_EQUAL_CHAR('B', singleMatrixKey(1));
  TEST_ASSERT_EQUAL_CHAR('I', singleMatrixKey(1UL << 2));
  TEST_ASSERT_EQUAL_CHAR('E', singleMatrixKey(1UL << 19));
  TEST_ASSERT_EQUAL_CHAR(0, singleMatrixKey(3));
  TEST_ASSERT_EQUAL_CHAR(0, singleMatrixKey((1UL << 20) | 1));
  TEST_ASSERT_EQUAL_CHAR(0, singleMatrixKey(0));
}
void test_quantity_rejects_zero_negative_decimal_overflow() {
  TEST_ASSERT_TRUE(validQuantity("1"));
  TEST_ASSERT_TRUE(validQuantity("999999"));
  TEST_ASSERT_FALSE(validQuantity("0"));
  TEST_ASSERT_FALSE(validQuantity(""));
  TEST_ASSERT_FALSE(validQuantity("-1"));
  TEST_ASSERT_FALSE(validQuantity("1.5"));
  TEST_ASSERT_FALSE(validQuantity("1000000"));
}
int main() {
  UNITY_BEGIN();
  RUN_TEST(test_scan_crlf_and_next_frame);
  RUN_TEST(test_scan_overflow_and_control_char_rejected);
  RUN_TEST(test_matrix_layout_and_multikey_rejection);
  RUN_TEST(test_quantity_rejects_zero_negative_decimal_overflow);
  return UNITY_END();
}
